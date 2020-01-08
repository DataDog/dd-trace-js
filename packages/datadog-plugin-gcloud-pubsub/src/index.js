'use strict'

function createWrapRequest (tracer, config) {
  return function wrapRequest (request) {
    return function wrappedRequest (cfg = { reqOpts: {} }, cb) {
      let topic
      if (cfg.reqOpts) {
        topic = cfg.reqOpts[cfg.method === 'createTopic' ? 'name' : 'topic']
      }
      const tags = {
        component: 'google-cloud-pubsub',
        'resource.name': topic || 'default',
        'service.name': config.service || `${tracer._service}-pubsub`,
        'pubsub.method': cfg.method,
        'pubsub.projectid': this.projectId,
        'pubsub.topic': topic
      }
      cb = tracer.scope().bind(cb)
      return tracer.trace('gpubsub.request', { tags }, (span, done) => {
        if (cfg.reqOpts && cfg.method === 'publish') {
          for (const msg of cfg.reqOpts.messages) {
            if (!msg.attributes) {
              msg.attributes = {}
            }
            tracer.inject(span, 'text_map', msg.attributes)
          }
        }

        arguments[arguments.length - 1] = function (err) {
          done(err)
          return cb.apply(this, arguments)
        }

        return request.apply(this, arguments)
      })
    }
  }
}

function createWrapSubsciptionEmit (tracer, config) {
  return function wrapSubscriptionEmit (emit) {
    return function wrappedSubscriptionEmit (eventName, message) {
      if (eventName !== 'message' || !message) {
        return emit.apply(this, arguments)
      }

      const topic = this.metadata ? this.metadata.topic : 'default'
      const tags = {
        component: 'google-cloud-pubsub',
        'resource.name': topic,
        'service.name': config.service || `${tracer._service}-pubsub`,
        'pubsub.projectid': this.pubsub.projectId,
        'pubsub.topic': topic
      }
      const childOf = tracer.extract('text_map', message.attributes)
      return tracer.trace('gpubsub.onmessage', { tags, childOf }, (span) => {
        return emit.apply(this, arguments)
      })
    }
  }
}

module.exports = [
  {
    name: '@google-cloud/pubsub',
    versions: ['>=1.2'],
    patch ({ PubSub, Subscription }, tracer, config) {
      this.wrap(PubSub.prototype, 'request', createWrapRequest(tracer, config))
      this.wrap(Subscription.prototype, 'emit', createWrapSubsciptionEmit(tracer, config))
    },
    unpatch ({ PubSub, Subscription }) {
      this.unwrap(PubSub.prototype, 'request')
      this.unwrap(Subscription.prototype, 'emit')
    }
  }
]
