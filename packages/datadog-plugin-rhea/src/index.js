function createWrapSend (tracer, config) {
  return function wrapSend (send) {
    return function sendWithTrace (msg, tag, format) {
      const name = this.options.target && this.options.target.address
        ? this.options.target.address : 'amq.topic'
      return tracer.trace('rhea.sender.send', { tags: {
        'resource.name': name,
        'service.name': config.service || `${tracer._service}-amqp`,
        'span.kind': 'producer',
        'amqp.link.target.address': name,
        'amqp.link.role': 'sender',
        'out.host': this.connection.options.host,
        'out.port': this.connection.options.port
      } }, (span, done) => {
        msg.delivery_annotations = msg.delivery_annotations || {}
        tracer.inject(span, 'text_map', msg.delivery_annotations)
        const delivery = send.apply(this, arguments)
        if (this.options.snd_settle_mode !== 1) {
          delivery._dd = { done, span }
        } else {
          done()
        }
        return delivery
      })
    }
  }
}

function createWrapConnectionDispatch (tracer, config) {
  return function wrapDispatch (dispatch) {
    return function dispatchWithTrace (eventName, obj) {
      if (eventName === 'disconnected') {
        for (const key in this.local_channel_map) {
          const session = this.local_channel_map[key]
          const addTags = entry => {
            if (entry && entry._dd) {
              const { span, done } = entry._dd
              const error = obj.error || this.saved_error
              if (error) {
                span.addTags({
                  'error.type': error.name,
                  'error.msg': error.message,
                  'error.stack': error.stack
                })
              }
              done()
            }
          }
          session.incoming.deliveries.entries.forEach(addTags)
          session.outgoing.deliveries.entries.forEach(addTags)
        }
      }
      return dispatch.apply(this, arguments)
    }
  }
}

function createWrapSenderDispatch (tracer, config) {
  return function wrapDispatch (dispatch) {
    return function dispatchWithTrace (eventName, obj) {
      if (eventName === 'settled') {
        const state = obj.delivery.remote_state.constructor.composite_type
        obj.delivery._dd.span.setTag('amqp.delivery.state', state)
        obj.delivery._dd.done()
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
        return tracer.trace('rhea.receiver.onmessage', {
          tags: {
            'resource.name': name,
            'service.name': config.service || `${tracer._service}-amqp`,
            'span.kind': 'consumer',
            'amqp.link.source.address': name,
            'amqp.link.role': 'receiver'
          },
          childOf
        }, (span, done) => {
          msgObj.delivery._dd = { done, span }
          wrapDeliveryMethod('accept', 'accepted', msgObj.delivery)
          wrapDeliveryMethod('release', 'released', msgObj.delivery)
          wrapDeliveryMethod('reject', 'rejected', msgObj.delivery)
          wrapDeliveryMethod('modified', 'modified', msgObj.delivery)
          if (!this.get_option('autoaccept', true)) {
            return dispatch.apply(this, arguments)
          } else {
            span.setTag('amqp.delivery.state', 'accepted')
            const d = dispatch.apply(this, arguments)
            done()
            return d
          }
        })
      }

      return dispatch.apply(this, arguments)
    }
  }
}

function wrapDeliveryMethod (name, stateName, delivery) {
  const method = delivery[name]
  delivery[name] = function (params) {
    this._dd.span.setTag('amqp.delivery.state', stateName)
    this._dd.done()
    return method.apply(this, arguments)
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
      this.wrap(Sender.prototype, 'dispatch', createWrapSenderDispatch(tracer, config))
    },
    unpatch ({ Sender, Receiver }, tracer) {
      this.unwrap(Sender.prototype, 'send')
      this.unwrap(Receiver.prototype, 'dispatch')
      this.unwrap(Sender.prototype, 'dispatch')
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
