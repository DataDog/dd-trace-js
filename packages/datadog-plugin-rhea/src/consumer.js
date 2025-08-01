'use strict'

const ConsumerPlugin = require('../../dd-trace/src/plugins/consumer')
const { getAmqpMessageSize } = require('../../dd-trace/src/datastreams')

class RheaConsumerPlugin extends ConsumerPlugin {
  static id = 'rhea'

  constructor (...args) {
    super(...args)

    this.addTraceSub('dispatch', (ctx) => {
      const span = ctx.currentStore.span
      span.setTag('amqp.delivery.state', ctx.state)
    })
  }

  bindStart (ctx) {
    const { msgObj } = ctx
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
    }, ctx)

    if (
      this.config.dsmEnabled &&
      msgObj?.message?.delivery_annotations
    ) {
      const payloadSize = getAmqpMessageSize(
        { headers: msgObj.message.delivery_annotations, content: msgObj.message.body }
      )
      this.tracer.decodeDataStreamsContext(msgObj.message.delivery_annotations)
      this.tracer
        .setCheckpoint(['direction:in', `topic:${name}`, 'type:rabbitmq'], span, payloadSize)
    }

    return ctx.currentStore
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
