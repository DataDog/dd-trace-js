'use strict'

const ConsumerPlugin = require('../../dd-trace/src/plugins/consumer')
const { getAmqpMessageSize } = require('../../dd-trace/src/datastreams')
const { identityService, noServiceSource } = require('../../dd-trace/src/service-naming/helpers')

/** @type {import('../../dd-trace/src/plugins/tracing').NamingSchema} */
const namingSchema = {
  v0: {
    operationName: () => 'amqp.receive',
    serviceName: identityService,
    serviceSource: noServiceSource,
  },
  v1: {
    operationName: () => 'amqp.process',
    serviceName: identityService,
    serviceSource: noServiceSource,
  },
}

class RheaConsumerPlugin extends ConsumerPlugin {
  static id = 'rhea'

  /** @override */
  getNamingSchema () {
    return namingSchema
  }

  constructor (...args) {
    super(...args)

    this.addTraceSub('dispatch', (ctx) => {
      const span = ctx.currentStore.span
      span.setTag('amqp.delivery.state', ctx.state)
    })
  }

  start (ctx) {
    if (!this.config.dsmEnabled) return
    const { msgObj } = ctx
    if (!msgObj?.message?.delivery_annotations) return

    const { span } = ctx.currentStore
    const name = getResourceNameFromMessage(msgObj)
    const payloadSize = getAmqpMessageSize(
      { headers: msgObj.message.delivery_annotations, content: msgObj.message.body }
    )
    this.tracer.decodeDataStreamsContext(msgObj.message.delivery_annotations)
    this.tracer
      .setCheckpoint(['direction:in', `topic:${name}`, 'type:rabbitmq'], span, payloadSize)
  }

  bindStart (ctx) {
    const { msgObj } = ctx
    const name = getResourceNameFromMessage(msgObj)
    const childOf = extractTextMap(msgObj, this.tracer)

    this.startSpan({
      childOf,
      resource: name,
      type: 'worker',
      meta: {
        component: 'rhea',
        'amqp.link.source.address': name,
        'amqp.link.role': 'receiver',
      },
    }, ctx)

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
