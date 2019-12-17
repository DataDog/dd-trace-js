'use strict'

let CircularBuffer
let popIf

function patchCircularBuffer (CircularBuffer) {
  popIf = CircularBuffer.prototype.pop_if
  CircularBuffer.prototype.pop_if = function (fn) {
    const wrappedFn = entry => {
      const shouldPop = fn(entry)
      if (shouldPop && entry._dd) {
        const state = entry.remote_state ? entry.remote_state.constructor.composite_type : 'accepted'
        finish(entry, state)
      }
      return shouldPop
    }
    return popIf.call(this, wrappedFn)
  }
}

function createWrapSend (tracer, config) {
  return function wrapSend (send) {
    return function sendWithTrace (msg, tag, format) {
      const name = this.options && this.options.target && this.options.target.address
        ? this.options.target.address : 'amq.topic'
      let host
      let port
      if (this.connection && this.connection.options) {
        if (this.connection.options.host !== undefined) { host = this.connection.options.host }
        if (this.connection.options.port !== undefined) { port = this.connection.options.port }
      }
      if (!CircularBuffer && this.session && this.session.outgoing && this.session.outgoing.deliveries) {
        CircularBuffer = this.session.outgoing.deliveries.constructor
        patchCircularBuffer(CircularBuffer)
      }
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
        if (msg) {
          msg.delivery_annotations = msg.delivery_annotations || {}
          tracer.inject(span, 'text_map', msg.delivery_annotations)
        }
        const delivery = send.apply(this, arguments)
        delivery._dd = { done, span }
        return delivery
      })
    }
  }
}

function createWrapConnectionDispatch (tracer, config) {
  function addTags (entry, error) {
    if (entry && entry._dd) {
      const { span, done } = entry._dd
      if (error) {
        span.addTags({ error })
      }
      done()
      delete entry._dd
    }
  }
  return function wrapDispatch (dispatch) {
    return function dispatchWithTrace (eventName, obj) {
      if (eventName === 'disconnected' && this.local_channel_map) {
        const error = obj.error || this.saved_error
        for (const key in this.local_channel_map) {
          const session = this.local_channel_map[key]
          if (session && session.incoming && session.incoming.deliveries && session.incoming.deliveries.entries) {
            for (const entry of session.incoming.deliveries.entries) { addTags(entry, error) }
          }
          if (session && session.outgoing && session.outgoing.deliveries && session.outgoing.deliveries.entries) {
            for (const entry of session.outgoing.deliveries.entries) { addTags(entry, error) }
          }
        }
      }
      return dispatch.apply(this, arguments)
    }
  }
}

function createWrapReceiverDispatch (tracer, config) {
  return function wrapDispatch (dispatch) {
    return function dispatchWithTrace (eventName, msgObj) {
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
          msgObj.delivery._dd = { done, span }
          wrapDeliveryUpdate(msgObj.delivery)
          let dispatched
          if (this.get_option('autoaccept', true)) {
            span.setTag('amqp.delivery.state', 'accepted')
            dispatched = dispatch.apply(this, arguments)
            done()
          } else {
            dispatched = dispatch.apply(this, arguments)
          }
          return dispatched
        })
      }

      return dispatch.apply(this, arguments)
    }
  }
}

function getStateFromData (stateData) {
  if (stateData && stateData.descriptor && stateData.descriptor.value) {
    switch (stateData.descriptor.value) {
      case 36: return 'accepted'
      case 37: return 'rejected'
      case 38: return 'released'
      case 39: return 'modified'
    }
  }
}

function wrapDeliveryUpdate (delivery) {
  const update = delivery.update
  delivery.update = function wrappedUpdate (settled, stateData) {
    if (!(this.link && this.link.get_option('autoaccept', true))) {
      const stateName = getStateFromData(stateData)
      finish(this, stateName)
    }
    return update.apply(this, arguments)
  }
}

function finish (delivery, state) {
  if (delivery._dd) {
    delivery._dd.span.setTag('amqp.delivery.state', state || 'accepted')
    delivery._dd.done()
    delete delivery._dd
  }
}

module.exports = [
  {
    name: 'rhea',
    versions: ['>=1'],
    file: 'lib/link.js',
    patch ({ Sender, Receiver }, tracer, config) {
      this.wrap(Sender.prototype, 'send', createWrapSend(tracer, config))
      this.wrap(Receiver.prototype, 'dispatch', createWrapReceiverDispatch(tracer, config))
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
      CircularBuffer.prototype.pop_if = popIf
      CircularBuffer = undefined
    }
  }
]
