'use strict'

const {
  channel,
  addHook,
  AsyncResource
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const circularBufferConstructor = Symbol('circularBufferConstructor')
const inFlightDeliveries = Symbol('inFlightDeliveries')

const patched = new WeakSet()
const dispatchCh = channel('apm:rhea:dispatch')
const errorCh = channel('apm:rhea:error')
const finishCh = channel('apm:rhea:finish')

const encodeCh = channel('apm:rhea:encode')

const contexts = new WeakMap()

addHook({ name: 'rhea', versions: ['>=1'] }, rhea => {
  shimmer.wrap(rhea.message, 'encode', encode => function (msg) {
    encodeCh.publish(msg)
    return encode.apply(this, arguments)
  })

  return rhea
})

addHook({ name: 'rhea', versions: ['>=1'], file: 'lib/link.js' }, obj => {
  const startSendCh = channel('apm:rhea:send:start')
  const startReceiveCh = channel('apm:rhea:receive:start')

  const Sender = obj.Sender
  const Receiver = obj.Receiver
  shimmer.wrap(Sender.prototype, 'send', send => function (msg, tag, format) {
    if (!canTrace(this)) {
      // we can't handle disconnects or ending spans, so we can't safely instrument
      return send.apply(this, arguments)
    }

    const { host, port } = getHostAndPort(this.connection)

    const targetAddress = this.options && this.options.target &&
      this.options.target.address ? this.options.target.address : undefined

    const asyncResource = new AsyncResource('bound-anonymous-fn')
    return asyncResource.runInAsyncScope(() => {
      // TODO: Figure out how to do this without re-encoding in instrumentation.
      if (Buffer.isBuffer(msg) && format !== undefined) {
        msg = this.connection.container.message.decode(msg)
        startSendCh.publish({ targetAddress, host, port, msg })
        arguments[0] = this.connection.container.message.encode(msg)
      } else {
        startSendCh.publish({ targetAddress, host, port, msg })
      }

      const delivery = send.apply(this, arguments)
      const context = {
        asyncResource
      }
      contexts.set(delivery, context)

      addToInFlightDeliveries(this.connection, delivery)
      try {
        return delivery
      } catch (err) {
        errorCh.publish(err)

        throw err
      }
    })
  })

  shimmer.wrap(Receiver.prototype, 'dispatch', dispatch => function (eventName, msgObj) {
    if (!canTrace(this)) {
      // we can't handle disconnects or ending spans, so we can't safely instrument
      return dispatch.apply(this, arguments)
    }

    if (eventName === 'message' && msgObj) {
      const asyncResource = new AsyncResource('bound-anonymous-fn')
      return asyncResource.runInAsyncScope(() => {
        startReceiveCh.publish({ msgObj, connection: this.connection })

        if (msgObj.delivery) {
          const context = {
            asyncResource
          }
          contexts.set(msgObj.delivery, context)
          msgObj.delivery.update = wrapDeliveryUpdate(msgObj.delivery, msgObj.delivery.update)
          addToInFlightDeliveries(this.connection, msgObj.delivery)
        }
        try {
          return dispatch.apply(this, arguments)
        } catch (err) {
          errorCh.publish(err)

          throw err
        }
      })
    }

    return dispatch.apply(this, arguments)
  })
  return obj
})

addHook({ name: 'rhea', versions: ['>=1'], file: 'lib/connection.js' }, Connection => {
  shimmer.wrap(Connection.prototype, 'dispatch', dispatch => function (eventName, obj) {
    if (eventName === 'disconnected') {
      const error = obj.error || this.saved_error
      if (this[inFlightDeliveries]) {
        this[inFlightDeliveries].forEach(delivery => {
          const context = contexts.get(delivery)
          const asyncResource = context && context.asyncResource

          if (!asyncResource) return

          asyncResource.runInAsyncScope(() => {
            errorCh.publish(error)
            finish(delivery, null)
          })
        })
      }
    }
    return dispatch.apply(this, arguments)
  })
  return Connection
})

addHook({ name: 'rhea', versions: ['>=1'], file: 'lib/session.js' }, (Session) => {
  patchCircularBuffer(Session.prototype, Session)
  return Session
})

function canTrace (link) {
  return link.connection && link.session && link.session.outgoing
}

function getHostAndPort (connection) {
  let host
  let port
  if (connection && connection.options) {
    host = connection.options.host
    port = connection.options.port
  }
  return { host, port }
}

function wrapDeliveryUpdate (obj, update) {
  const context = contexts.get(obj)
  const asyncResource = context.asyncResource
  if (obj && asyncResource) {
    const cb = asyncResource.bind(update)
    return AsyncResource.bind(function wrappedUpdate (settled, stateData) {
      const state = getStateFromData(stateData)
      dispatchCh.publish({ state })
      return cb.apply(this, arguments)
    })
  }
  return function wrappedUpdate (settled, stateData) {
    return update.apply(this, arguments)
  }
}

function patchCircularBuffer (proto, Session) {
  Object.defineProperty(proto, 'outgoing', {
    configurable: true,
    get () { return undefined },
    set (outgoing) {
      delete proto.outgoing // removes the setter on the prototype
      this.outgoing = outgoing // assigns on the instance, like normal
      if (outgoing) {
        let CircularBuffer
        if (outgoing.deliveries) {
          CircularBuffer = outgoing.deliveries.constructor
        }
        if (CircularBuffer && !patched.has(CircularBuffer.prototype)) {
          shimmer.wrap(CircularBuffer.prototype, 'pop_if', popIf => function (fn) {
            arguments[0] = AsyncResource.bind(function (entry) {
              const context = contexts.get(entry)
              const asyncResource = context && context.asyncResource

              if (!asyncResource) return fn(entry)

              const shouldPop = asyncResource.runInAsyncScope(() => fn(entry))

              if (shouldPop) {
                const remoteState = entry.remote_state
                const state = remoteState && remoteState.constructor
                  ? entry.remote_state.constructor.composite_type : undefined
                asyncResource.runInAsyncScope(() => {
                  return finish(entry, state)
                })
              }

              return shouldPop
            })
            return popIf.apply(this, arguments)
          })
          patched.add(CircularBuffer.prototype)
          const Session = proto.constructor
          if (Session) {
            Session[circularBufferConstructor] = CircularBuffer
          }
        }
      }
    }
  })
}

function addToInFlightDeliveries (connection, delivery) {
  let deliveries = connection[inFlightDeliveries]
  if (!deliveries) {
    deliveries = new Set()
    connection[inFlightDeliveries] = deliveries
  }
  deliveries.add(delivery)
}

function finish (delivery, state) {
  const obj = contexts.get(delivery)
  if (obj) {
    if (state) {
      dispatchCh.publish({ state })
    }
    finishCh.publish(undefined)
    if (obj.connection && obj.connection[inFlightDeliveries]) {
      obj.connection[inFlightDeliveries].delete(delivery)
    }
  }
}

function getStateFromData (stateData) {
  if (stateData && stateData.descriptor && stateData.descriptor) {
    switch (stateData.descriptor.value) {
      case 0x24: return 'accepted'
      case 0x25: return 'rejected'
      case 0x26: return 'released'
      case 0x27: return 'modified'
    }
  }
}
