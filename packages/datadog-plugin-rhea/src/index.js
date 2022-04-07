'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')
const { storage } = require('../../datadog-core')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')

class RheaPlugin extends Plugin {
  static get name () {
    return 'rhea'
  }

  constructor (...args) {
    super(...args)

    this.addSub(`apm:rhea:send:start`, ({ targetAddress, host, port, msg }) => {
      const store = storage.getStore()
      const childOf = store ? store.span : store
      const name = targetAddress || 'amq.topic'
      const span = this.tracer.startSpan('amqp.send', {
        childOf,
        tags: {
          'component': 'rhea',
          'resource.name': name,
          'service.name': this.config.service || `${this.tracer._service}-amqp-producer`,
          'span.kind': 'producer',
          'amqp.link.target.address': name,
          'amqp.link.role': 'sender',
          'out.host': host,
          'out.port': port
        }
      })
      analyticsSampler.sample(span, this.config.measured)
      addDeliveryAnnotations(msg, this.tracer, span)

      this.enter(span, store)
    })

    this.addSub(`apm:rhea:receive:start`, ({ msgObj, connection }) => {
      const name = getResourceNameFromMessage(msgObj)

      const store = storage.getStore()
      const childOf = extractTextMap(msgObj, this.tracer)
      const span = this.tracer.startSpan('amqp.receive', {
        childOf,
        tags: {
          'span.type': 'worker',
          'component': 'rhea',
          'resource.name': name,
          'service.name': this.config.service || this.tracer._service,
          'span.kind': 'consumer',
          'amqp.link.source.address': name,
          'amqp.link.role': 'receiver'
        }
      })
      analyticsSampler.sample(span, this.config.measured, true)

      this.enter(span, store)
    })

    this.addSub(`apm:rhea:error`, error => {
      storage.getStore().span.setTag('error', error)
    })

    this.addSub(`apm:rhea:async-end`, () => {
      const span = storage.getStore().span
      span.finish()
    })

    this.addSub(`apm:rhea:end`, () => {
      this.exit()
    })

    this.addSub(`apm:rhea:dispatch`, ({ state }) => {
      const span = storage.getStore().span
      span.setTag('amqp.delivery.state', state)
    })
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

function extractTextMap (msgObj, tracer) {
  if (msgObj.message) {
    return tracer.extract('text_map', msgObj.message.delivery_annotations)
  }
}

function addDeliveryAnnotations (msg, tracer, span) {
  if (msg) {
    msg.delivery_annotations = msg.delivery_annotations || {}

    tracer.inject(span, 'text_map', msg.delivery_annotations)
  }
}

module.exports = RheaPlugin
