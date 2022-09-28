'use strict'

const ConsumerPlugin = require('../../dd-trace/src/plugins/consumer')
const { storage } = require('../../datadog-core')

class RheaConsumerPlugin extends ConsumerPlugin {
  static get name () { return 'rhea' }

  constructor (...args) {
    super(...args)

    // TODO: Remove this as it has no use.
    this.addTraceSub('dispatch', ({ state }) => {
      const span = storage.getStore().span
      span.setTag('amqp.delivery.state', state)
    })
  }

  start ({ msgObj }) {
    const name = getResourceNameFromMessage(msgObj)
    const childOf = extractTextMap(msgObj, this.tracer)

    this.startSpan('amqp.receive', {
      childOf,
      service: this.config.service,
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
