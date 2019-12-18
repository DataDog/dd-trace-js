'use strict'

const dd = Symbol('datadog')
const circularBufferConstructor = Symbol('circularBufferConstructor')

function createWrapSend (tracer, config, instrumenter) {
  return function wrapSend (send) {
    return function sendWithTrace (msg, tag, format) {
      patchCircularBuffer(this, instrumenter)
      const name = this.options && this.options.target && this.options.target.address
        ? this.options.target.address : 'amq.topic'
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
        return delivery
      })
    }
  }
}

function createWrapConnectionDispatch (tracer, config) {
  return function wrapDispatch (dispatch) {
    return function dispatchWithTrace (eventName, obj) {
      if (eventName === 'disconnected' && this.local_channel_map) {
        const error = obj.error || this.saved_error
        for (const key in this.local_channel_map) {
          const session = this.local_channel_map[key]
          if (session) {
            finishDeliverySpans(session.incoming, error)
            finishDeliverySpans(session.outgoing, error)
          }
        }
      }
      return dispatch.apply(this, arguments)
    }
  }
}

function createWrapReceiverDispatch (tracer, config, instrumenter) {
  return function wrapDispatch (dispatch) {
    return function dispatchWithTrace (eventName, msgObj) {
      patchCircularBuffer(this, instrumenter)
      if (eventName === 'message') {
        const name = msgObj.receiver.options.source && msgObj.receiver.options.source.address
          ? msgObj.receiver.options.source.address : 'amq.topic'
        const childOf = tracer.extract('text_map', msgObj.message.delivery_annotations)
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
          msgObj.delivery[dd] = { done, span }
          msgObj.delivery.update = wrapDeliveryUpdate(msgObj.delivery.update)
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
          const state = remoteState && remoteState.constructor && remoteState.constructor.composite_type
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
  const wrappedUpdate = function wrappedUpdate (settled, stateData) {
    const state = getStateFromData(stateData)
    if (state) {
      this[dd].span.setTag('amqp.delivery.state', state)
    }
    return update.apply(this, arguments)
  }
  return wrappedUpdate
}

function patchCircularBuffer (senderOrReceiver, instrumenter) {
  const session = senderOrReceiver.session
  if (!session) return
  const deliveries = session.outgoing ? session.outgoing.deliveries
    : (session.incoming ? session.incoming.deliveries : undefined)
  if (deliveries && deliveries.constructor) {
    const CircularBuffer = deliveries.constructor
    if (CircularBuffer && !CircularBuffer.prototype.pop_if._datadog_patched) {
      instrumenter.wrap(CircularBuffer.prototype, 'pop_if', createWrapCircularBufferPopIf())
      const SenderOrReceiver = senderOrReceiver.constructor
      if (SenderOrReceiver) {
        SenderOrReceiver[circularBufferConstructor] = CircularBuffer
      }
    }
  }
}

function finishDeliverySpans (inOrOut, error) {
  if (inOrOut && inOrOut.deliveries && inOrOut.deliveries.entries) {
    for (const entry of inOrOut.deliveries.entries) {
      if (entry && entry[dd]) {
        const { span, done } = entry[dd]
        span.addTags({ error })
        done()
        delete entry[dd]
      }
    }
  }
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
    delete delivery[dd]
  }
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
      if (Sender[circularBufferConstructor]) {
        this.unwrap(Sender[circularBufferConstructor].prototype, 'pop_if')
      }
      if (Receiver[circularBufferConstructor]) {
        this.unwrap(Receiver[circularBufferConstructor].prototype, 'pop_if')
      }
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
  }
]
