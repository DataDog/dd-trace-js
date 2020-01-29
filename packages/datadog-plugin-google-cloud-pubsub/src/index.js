'use strict'

function createWrapRequest (tracer, config) {
  return function wrapRequest (request) {
    return function requestWithTrace (cfg = { reqOpts: {} }, cb) {
      const topic = getTopic(cfg)
      const tags = {
        component: '@google-cloud/pubsub',
        'resource.name': [cfg.method, topic].filter(x => x).join(' '),
        'service.name': config.service || `${tracer._service}-pubsub`,
        'pubsub.method': cfg.method,
        'gcloud.project_id': this.projectId,
        'pubsub.topic': topic
      }
      if (cfg.method === 'publish') {
        tags['span.kind'] = 'producer'
      }
      cb = tracer.scope().bind(cb)
      return tracer.trace('pubsub.request', { tags }, (span, done) => {
        if (cfg.reqOpts && cfg.method === 'publish') {
          for (const msg of cfg.reqOpts.messages) {
            if (!msg.attributes) {
              msg.attributes = {}
            }
            tracer.inject(span, 'text_map', msg.attributes)
          }
        }

        arguments[1] = function (err) {
          done(err)
          return cb.apply(this, arguments)
        }

        return request.apply(this, arguments)
      })
    }
  }
}

function createWrapSubscriptionEmit (tracer, config) {
  return function wrapSubscriptionEmit (emit) {
    return function emitWithTrace (eventName, message) {
      if (eventName !== 'message' || !message) {
        return emit.apply(this, arguments)
      }

      const topic = this.metadata && this.metadata.topic
      const tags = {
        component: '@google-cloud/pubsub',
        'resource.name': topic,
        'service.name': config.service || tracer._service,
        'gcloud.project_id': this.pubsub.projectId,
        'pubsub.topic': topic,
        'span.kind': 'consumer'
      }
      const childOf = tracer.extract('text_map', message.attributes)
      return tracer.trace('pubsub.receive', { tags, childOf }, (span) => {
        return emit.apply(this, arguments)
      })
    }
  }
}

function getTopic (cfg) {
  if (cfg.reqOpts) {
    return cfg.reqOpts[cfg.method === 'createTopic' ? 'name' : 'topic']
  }
}

module.exports = [
  {
    name: '@google-cloud/pubsub',
    versions: ['>=1.1'],
    patch ({ PubSub, Subscription }, tracer, config) {
      this.wrap(PubSub.prototype, 'request', createWrapRequest(tracer, config))
      this.wrap(Subscription.prototype, 'emit', createWrapSubscriptionEmit(tracer, config))
    },
    unpatch ({ PubSub, Subscription }) {
      this.unwrap(PubSub.prototype, 'request')
      this.unwrap(Subscription.prototype, 'emit')
    }
  }
]
