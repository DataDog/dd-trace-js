'use strict'

const dd = Symbol('datadog')
const circularBufferConstructor = Symbol('circularBufferConstructor')
const inFlightDeliveries = Symbol('inFlightDeliveries')

function createWrapSend (tracer, config, instrumenter) {
  return function wrapSend (send) {
    return function sendWithTrace (msg, tag, format) {
      if (!canTrace(this)) {
        // we can't handle disconnects or ending spans, so we can't safely instrument
        return send.apply(this, arguments)
      }
      const name = getResourceNameFromSender(this)
      const { host, port } = getHostAndPort(this.connection)
      return tracer.trace('amqp.send', {
        tags: {
          'component': 'rhea',
          'resource.name': name,
          'service.name': config.service || `${tracer._service}-amqp-producer`,
          'span.kind': 'producer',
          'amqp.link.target.address': name,
          'amqp.link.role': 'sender',
          'out.host': host,
          'out.port': port
        }
      }, (span, done) => {
        addDeliveryAnnotations(msg, tracer, span)
        const delivery = send.apply(this, arguments)
        delivery[dd] = { done, span }
        addToInFlightDeliveries(this.connection, delivery)
        return delivery
      })
    }
  }
}

function createWrapConnectionDispatch (tracer, config) {
  return function wrapDispatch (dispatch) {
    return function dispatchWithTrace (eventName, obj) {
      if (eventName === 'disconnected') {
        const error = obj.error || this.saved_error
        if (this[inFlightDeliveries]) {
          this[inFlightDeliveries].forEach(delivery => {
            const { span } = delivery[dd]
            span.addTags({ error })
            finish(delivery, null)
          })
        }
      }
      return dispatch.apply(this, arguments)
    }
  }
}

function createWrapReceiverDispatch (tracer, config, instrumenter) {
  return function wrapDispatch (dispatch) {
    return function dispatchWithTrace (eventName, msgObj) {
      if (!canTrace(this)) {
        // we can't handle disconnects or ending spans, so we can't safely instrument
        return dispatch.apply(this, arguments)
      }
      if (eventName === 'message' && msgObj) {
        const name = getResourceNameFromMessage(msgObj)
        const childOf = getAnnotations(msgObj, tracer)
        return tracer.trace('amqp.receive', {
          tags: {
            'component': 'rhea',
            'resource.name': name,
            'service.name': config.service || tracer._service,
            'span.kind': 'consumer',
            'amqp.link.source.address': name,
            'amqp.link.role': 'receiver'
          },
          childOf
        }, (span, done) => {
          if (msgObj.delivery) {
            msgObj.delivery[dd] = { done, span }
            msgObj.delivery.update = wrapDeliveryUpdate(msgObj.delivery.update)
            addToInFlightDeliveries(this.connection, msgObj.delivery)
          }
          return dispatch.apply(this, arguments)
        })
      }

      return dispatch.apply(this, arguments)
    }
  }
}

function createWrapCircularBufferPopIf () {
  return function wrapCircularBufferPopIf (popIf) {
    return function wrappedPopIf (fn) {
      const wrappedFn = entry => {
        const shouldPop = fn(entry)
        if (shouldPop && entry[dd]) {
          const remoteState = entry.remote_state
          const state = remoteState && remoteState.constructor
            ? entry.remote_state.constructor.composite_type : undefined
          finish(entry, state)
        }
        return shouldPop
      }
      return popIf.call(this, wrappedFn)
    }
  }
}

function wrapDeliveryUpdate (update) {
  return function wrappedUpdate (settled, stateData) {
    if (this[dd]) {
      const state = getStateFromData(stateData)
      this[dd].span.setTag('amqp.delivery.state', state)
    }
    return update.apply(this, arguments)
  }
}

function patchCircularBuffer (proto, instrumenter) {
  Object.defineProperty(proto, 'outgoing', {
    configurable: true,
    get () {},
    set (outgoing) {
      delete proto.outgoing // removes the setter on the prototype
      this.outgoing = outgoing // assigns on the instance, like normal
      if (outgoing) {
        let CircularBuffer
        if (outgoing.deliveries) {
          CircularBuffer = outgoing.deliveries.constructor
        }
        if (CircularBuffer && !CircularBuffer.prototype.pop_if._datadog_patched) {
          instrumenter.wrap(CircularBuffer.prototype, 'pop_if', createWrapCircularBufferPopIf())
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
  delivery[dd].connection = connection
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

function addDeliveryAnnotations (msg, tracer, span) {
  if (msg) {
    msg.delivery_annotations = msg.delivery_annotations || {}
    tracer.inject(span, 'text_map', msg.delivery_annotations)
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

function finish (delivery, state) {
  if (delivery[dd]) {
    if (state) {
      delivery[dd].span.setTag('amqp.delivery.state', state)
    }
    delivery[dd].done()
    if (delivery[dd].connection && delivery[dd].connection[inFlightDeliveries]) {
      delivery[dd].connection[inFlightDeliveries].delete(delivery)
    }
    delete delivery[dd]
  }
}

function getResourceNameFromMessage (msgObj) {
  let resourceName = 'amq.topic'
  let options = {}
  if (msgObj.receiver && msgObj.receiver.options) {
    options = msgObj.receiver.options
  }
  if (options.source && options.source.address) {
    resourceName = options.source.address
  }
  return resourceName
}

function getResourceNameFromSender (sender) {
  let resourceName = 'amq.topic'
  if (sender.options && sender.options.target && sender.options.target.address) {
    resourceName = sender.options.target.address
  }
  return resourceName
}

function getAnnotations (msgObj, tracer) {
  if (msgObj.message) {
    return tracer.extract('text_map', msgObj.message.delivery_annotations)
  }
}

function canTrace (link) {
  return link.connection && link.session && link.session.outgoing
}

module.exports = [
  {
    name: 'rhea',
    versions: ['>=1'],
    file: 'lib/link.js',
    patch ({ Sender, Receiver }, tracer, config) {
      this.wrap(Sender.prototype, 'send', createWrapSend(tracer, config, this))
      this.wrap(Receiver.prototype, 'dispatch', createWrapReceiverDispatch(tracer, config, this))
    },
    unpatch ({ Sender, Receiver }, tracer) {
      this.unwrap(Sender.prototype, 'send')
      this.unwrap(Receiver.prototype, 'dispatch')
    }
  },
  {
    name: 'rhea',
    versions: ['>=1'],
    file: 'lib/connection.js',
    patch (Connection, tracer, config) {
      this.wrap(Connection.prototype, 'dispatch', createWrapConnectionDispatch(tracer, config))
    },
    unpatch (Connection, tracer) {
      this.unwrap(Connection.prototype, 'dispatch')
    }
  },
  {
    name: 'rhea',
    versions: ['>=1'],
    file: 'lib/session.js',
    patch (Session, tracer, config) {
      patchCircularBuffer(Session.prototype, this)
    },
    unpatch (Session, tracer) {
      if (Session[circularBufferConstructor]) {
        this.unwrap(Session[circularBufferConstructor].prototype, 'pop_if')
      }
    }
  }
]
