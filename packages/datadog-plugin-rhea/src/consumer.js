'use strict'

const ConsumerPlugin = require('../../dd-trace/src/plugins/consumer')
const { storage } = require('../../datadog-core')
const { getAmqpMessageSize } = require('../../dd-trace/src/datastreams/processor')
const { DsmPathwayCodec } = require('../../dd-trace/src/datastreams/pathway')

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

    const span = this.startSpan({
      childOf,
      resource: name,
      type: 'worker',
      meta: {
        component: 'rhea',
        'amqp.link.source.address': name,
        'amqp.link.role': 'receiver'
      }
    })

    if (
      this.config.dsmEnabled &&
      msgObj?.message?.delivery_annotations &&
      DsmPathwayCodec.contextExists(msgObj.message.delivery_annotations)
    ) {
      const payloadSize = getAmqpMessageSize(
        { headers: msgObj.message.delivery_annotations, content: msgObj.message.body }
      )
      this.tracer.decodeDataStreamsContext(msgObj.message.delivery_annotations)
      this.tracer
        .setCheckpoint(['direction:in', `topic:${name}`, 'type:rabbitmq'], span, payloadSize)
    }
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
