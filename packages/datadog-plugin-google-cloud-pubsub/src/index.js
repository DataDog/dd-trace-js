'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')
const { storage } = require('../../datadog-core')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')

const messageSpans = new WeakMap()
class GoogleCloudPubsubPlugin extends Plugin {
  static get name () {
    return 'google-cloud-pubsub'
  }

  constructor (...args) {
    super(...args)

    this.addSub(`apm:google-cloud-pubsub:request:start`, ({ cfg, projectId, messages }) => {
      const store = storage.getStore()
      const childOf = store ? store.span : store
      const topic = getTopic(cfg)
      const tags = {
        component: '@google-cloud/pubsub',
        'resource.name': [cfg.method, topic].filter(x => x).join(' '),
        'service.name': this.config.service || `${this.tracer._service}-pubsub`,
        'span.kind': 'client',
        'pubsub.method': cfg.method,
        'gcloud.project_id': projectId,
        'pubsub.topic': topic
      }
      if (cfg.method === 'publish') {
        tags['span.kind'] = 'producer'
      }
      const span = this.tracer.startSpan('pubsub.request', {
        childOf,
        tags
      })

      analyticsSampler.sample(span, this.config.measured)
      this.enter(span, store)

      for (const msg of messages) {
        if (!msg.attributes) {
          msg.attributes = {}
        }
        this.tracer.inject(span, 'text_map', msg.attributes)
      }
    })

    this.addSub(`apm:google-cloud-pubsub:receive:start`, ({ message }) => {
      const store = storage.getStore()
      const subscription = message._subscriber._subscription
      const topic = subscription.metadata && subscription.metadata.topic
      const childOf = this.tracer.extract('text_map', message.attributes)
      const tags = {
        component: '@google-cloud/pubsub',
        'resource.name': topic,
        'service.name': this.config.service || this.tracer._service,
        'gcloud.project_id': subscription.pubsub.projectId,
        'pubsub.topic': topic,
        'span.kind': 'consumer',
        'span.type': 'worker'
      }

      const span = this.tracer.startSpan('pubsub.receive', {
        childOf,
        tags
      })

      analyticsSampler.sample(span, this.config.measured, true)
      this.enter(span, store)

      messageSpans.set(message, span)
    })

    this.addSub(`apm:google-cloud-pubsub:request:error`, err => {
      const span = storage.getStore().span
      span.setTag('error', err)
    })

    this.addSub(`apm:google-cloud-pubsub:request:finish`, () => {
      const span = storage.getStore().span
      span.finish()
    })

    this.addSub(`apm:google-cloud-pubsub:receive:error`, ({ err, message }) => {
      const span = messageSpans.get(message)
      if (!span) return undefined
      span.setTag('error', err)
    })

    this.addSub(`apm:google-cloud-pubsub:receive:finish`, ({ message }) => {
      const span = messageSpans.get(message)
      if (!span) return
      span.setTag('pubsub.ack', message._handled ? 1 : 0)
      span.finish()
    })
  }
}

function getTopic (cfg) {
  if (cfg.reqOpts) {
    return cfg.reqOpts[cfg.method === 'createTopic' ? 'name' : 'topic']
  }
}

module.exports = GoogleCloudPubsubPlugin
