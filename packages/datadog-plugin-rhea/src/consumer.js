'use strict'

const ConsumerPlugin = require('../../dd-trace/src/plugins/consumer')
const { storage } = require('../../datadog-core')
const Naming = require('../../dd-trace/src/service-naming')

class RheaConsumerPlugin extends ConsumerPlugin {
  static get id () { return 'rhea' }

  constructor (...args) {
    super(...args)

    this.addTraceSub('dispatch', ({ state }) => {
      const span = storage.getStore().span
      span.setTag('amqp.delivery.state', state)
    })
  }

  start ({ msgObj }) {
    const name = getResourceNameFromMessage(msgObj)
    const childOf = extractTextMap(msgObj, this.tracer)
    const naming = Naming.schema.messaging.inbound.rhea

    this.startSpan(naming.opName(), {
      childOf,
      service: this.config.service || naming.serviceName(this.tracer._service),
      resource: name,
      type: 'worker',
      kind: 'consumer',
      meta: {
        'component': 'rhea',
        'amqp.link.source.address': name,
        'amqp.link.role': 'receiver'
      }
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

module.exports = RheaConsumerPlugin
