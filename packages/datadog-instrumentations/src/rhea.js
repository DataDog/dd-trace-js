'use strict'

const {
  channel,
  addHook
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const circularBufferConstructor = Symbol('circularBufferConstructor')
const inFlightDeliveries = Symbol('inFlightDeliveries')

const patched = new WeakSet()

const startSendCh = channel('apm:rhea:send:start')
const encodeSendCh = channel('apm:rhea:send:encode')
const errorSendCh = channel('apm:rhea:send:error')
const finishSendCh = channel('apm:rhea:send:finish')

const startReceiveCh = channel('apm:rhea:receive:start')
const dispatchReceiveCh = channel('apm:rhea:receive:dispatch')
const errorReceiveCh = channel('apm:rhea:receive:error')
const finishReceiveCh = channel('apm:rhea:receive:finish')

const contexts = new WeakMap() // key: delivery Fn, val: context

addHook({ name: 'rhea', versions: ['>=1'] }, rhea => {
  shimmer.wrap(rhea.message, 'encode', encode => function (msg) {
    encodeSendCh.publish(msg)
    return encode.apply(this, arguments)
  })

  return rhea
})

addHook({ name: 'rhea', versions: ['>=1'], file: 'lib/link.js' }, obj => {
  const Sender = obj.Sender
  const Receiver = obj.Receiver
  shimmer.wrap(Sender.prototype, 'send', send => function (msg, tag, format) {
    if (!canTrace(this)) {
      // we can't handle disconnects or ending spans, so we can't safely instrument
      return send.apply(this, arguments)
    }

    const { host, port } = getHostAndPort(this.connection)

    const targetAddress = this.options && this.options.target &&
      this.options.target.address
      ? this.options.target.address
      : undefined

    const ctx = { targetAddress, host, port, msg, connection: this.connection }
    return startSendCh.runStores(ctx, () => {
      const delivery = send.apply(this, arguments)
      contexts.set(delivery, ctx)

      addToInFlightDeliveries(this.connection, delivery)
      try {
        return delivery
      } catch (err) {
        ctx.error = err
        errorSendCh.publish(ctx)

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
      const ctx = { msgObj, connection: this.connection }
      return startReceiveCh.runStores(ctx, () => {
        if (msgObj.delivery) {
          contexts.set(msgObj.delivery, ctx)
          msgObj.delivery.update = wrapDeliveryUpdate(msgObj.delivery, msgObj.delivery.update)
          addToInFlightDeliveries(this.connection, msgObj.delivery)
        }
        try {
          return dispatch.apply(this, arguments)
        } catch (err) {
          ctx.error = err
          errorReceiveCh.publish(ctx)

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
          const ctx = contexts.get(delivery)

          if (!ctx) return

          ctx.error = error
          errorReceiveCh.publish(ctx)
          exports.beforeFinish(delivery, null)
          finishReceiveCh.publish(ctx)
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
  const ctx = contexts.get(obj)
  if (obj && ctx) {
    const cb = update
    return shimmer.wrapFunction(cb, cb => function wrappedUpdate (settled, stateData) {
      ctx.state = getStateFromData(stateData)
      dispatchReceiveCh.runStores(ctx, () => {
        return cb.apply(this, arguments)
      })
    })
  }
  return function wrappedUpdate (settled, stateData) {
    return update.apply(this, arguments)
  }
}

function patchCircularBuffer (proto, Session) {
  Object.defineProperty(proto, 'outgoing', {
    configurable: true,
    // eslint-disable-next-line getter-return
    get () {},
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
            arguments[0] = shimmer.wrapFunction(fn, fn => function (entry) {
              const ctx = contexts.get(entry)

              if (!ctx) return fn(entry)

              const shouldPop = fn(entry)

              if (shouldPop) {
                const remoteState = entry.remote_state
                const state = remoteState && remoteState.constructor
                  ? entry.remote_state.constructor.composite_type
                  : undefined
                ctx.state = state
                exports.beforeFinish(entry, state)
                finishSendCh.publish(ctx)
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

function beforeFinish (delivery, state) {
  const ctx = contexts.get(delivery)
  if (ctx) {
    if (state) {
      ctx.state = state
      dispatchReceiveCh.publish(ctx)
    }
    if (ctx.connection && ctx.connection[inFlightDeliveries]) {
      ctx.connection[inFlightDeliveries].delete(delivery)
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

module.exports.inFlightDeliveries = inFlightDeliveries
module.exports.beforeFinish = beforeFinish
module.exports.contexts = contexts
