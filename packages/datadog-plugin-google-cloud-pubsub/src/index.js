'use strict'

const analyticsSampler = require('../../dd-trace/src/analytics_sampler')

const messageSpans = new WeakMap()

function createWrapRequest (tracer, config) {
  return function wrapRequest (request) {
    return function requestWithTrace (cfg = { reqOpts: {} }, cb) {
      const topic = getTopic(cfg)
      const tags = {
        component: '@google-cloud/pubsub',
        'resource.name': [cfg.method, topic].filter(x => x).join(' '),
        'service.name': config.service || `${tracer._service}-pubsub`,
        'span.kind': 'client',
        'pubsub.method': cfg.method,
        'gcloud.project_id': this.projectId,
        'pubsub.topic': topic
      }
      if (cfg.method === 'publish') {
        tags['span.kind'] = 'producer'
      }
      cb = tracer.scope().bind(cb)
      return tracer.trace('pubsub.request', { tags }, (span, done) => {
        analyticsSampler.sample(span, config.measured)

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
      if (eventName !== 'message' || !message) return emit.apply(this, arguments)

      const span = messageSpans.get(message)

      if (!span) return emit.apply(this, arguments)

      return tracer.scope().activate(span, () => {
        try {
          return emit.apply(this, arguments)
        } catch (e) {
          span.setTag('error', e)
          throw e
        }
      })
    }
  }
}

function createWrapLeaseDispense (tracer, config) {
  return function wrapDispense (dispense) {
    return function dispenseWithTrace (message) {
      const subscription = message._subscriber._subscription
      const topic = subscription.metadata && subscription.metadata.topic
      const tags = {
        component: '@google-cloud/pubsub',
        'resource.name': topic,
        'service.name': config.service || tracer._service,
        'gcloud.project_id': subscription.pubsub.projectId,
        'pubsub.topic': topic,
        'span.kind': 'consumer',
        'span.type': 'worker'
      }

      const childOf = tracer.extract('text_map', message.attributes)
      const span = tracer.startSpan('pubsub.receive', { tags, childOf })

      analyticsSampler.sample(span, config.measured, true)

      messageSpans.set(message, span)

      return dispense.apply(this, arguments)
    }
  }
}

function createWrapLeaseRemove (tracer, config) {
  return function wrapRemove (remove) {
    return function removeWithTrace (message) {
      finish(message)

      return remove.apply(this, arguments)
    }
  }
}

function createWrapLeaseClear (tracer, config) {
  return function wrapClear (clear) {
    return function clearWithTrace () {
      for (const message of this._messages) {
        finish(message)
      }

      return clear.apply(this, arguments)
    }
  }
}

function getTopic (cfg) {
  if (cfg.reqOpts) {
    return cfg.reqOpts[cfg.method === 'createTopic' ? 'name' : 'topic']
  }
}

function finish (message) {
  const span = messageSpans.get(message)

  if (!span) return

  span.setTag('pubsub.ack', message._handled ? 1 : 0)
  span.finish()
}

module.exports = [
  {
    name: '@google-cloud/pubsub',
    versions: ['>=1.2'],
    patch ({ PubSub, Subscription }, tracer, config) {
      this.wrap(PubSub.prototype, 'request', createWrapRequest(tracer, config))
      this.wrap(Subscription.prototype, 'emit', createWrapSubscriptionEmit(tracer, config))
    },
    unpatch ({ PubSub, Subscription }) {
      this.unwrap(PubSub.prototype, 'request')
      this.unwrap(Subscription.prototype, 'emit')
    }
  },
  {
    name: '@google-cloud/pubsub',
    versions: ['>=1.2'],
    file: 'build/src/lease-manager.js',
    patch ({ LeaseManager }, tracer, config) {
      this.wrap(LeaseManager.prototype, '_dispense', createWrapLeaseDispense(tracer, config))
      this.wrap(LeaseManager.prototype, 'remove', createWrapLeaseRemove(tracer, config))
      this.wrap(LeaseManager.prototype, 'clear', createWrapLeaseClear(tracer, config))
    },
    unpatch ({ LeaseManager }) {
      this.unwrap(LeaseManager.prototype, '_dispense')
      this.unwrap(LeaseManager.prototype, 'remove')
      this.unwrap(LeaseManager.prototype, 'clear')
    }
  }
]
