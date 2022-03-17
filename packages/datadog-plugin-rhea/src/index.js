'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')

class RheaPlugin extends Plugin {
  static get name () {
    return 'rhea'
  }

  constructor (...args) {
    super(...args)

    this.addSub(`apm:rhea:send:start`, ({ targetAddress, host, port, msg }) => {
      const name = targetAddress || 'amq.topic'
      const span = this.startSpan('amqp.send', {
        resource: name,
        service: this.config.service || `${this.tracer.config.service}-amqp-producer`,
        kind: 'producer',
        meta: {
          'component': 'rhea',
          'amqp.link.target.address': name,
          'amqp.link.role': 'sender',
          'out.host': host,
          'out.port': port
        }
      })

      addDeliveryAnnotations(msg, this.tracer, span)
    })

    this.addSub(`apm:rhea:receive:start`, ({ msgObj }) => {
      const name = getResourceNameFromMessage(msgObj)
      const childOf = extractTextMap(msgObj, this.tracer)

      this.startSpan('amqp.receive', {
        childOf,
        resource: name,
        service: this.config.service || this.tracer.config.service,
        kind: 'consumer',
        type: 'worker',
        meta: {
          'component': 'rhea',
          'amqp.link.source.address': name,
          'amqp.link.role': 'receiver'
        }
      })
    })

    this.addSub(`apm:rhea:error`, error => {
      this.addError(error)
    })

    this.addSub(`apm:rhea:async-end`, () => {
      this.finishSpan()
    })

    this.addSub(`apm:rhea:end`, () => {
      this.exit()
    })

    this.addSub(`apm:rhea:dispatch`, ({ state }) => {
      this.activeSpan.meta['amqp.delivery.state'] = state
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
