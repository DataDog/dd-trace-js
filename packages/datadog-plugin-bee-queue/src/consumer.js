'use strict'

const ConsumerPlugin = require('../../dd-trace/src/plugins/consumer')
const { getMessageSize } = require('../../dd-trace/src/datastreams')

class BeeQueueConsumerPlugin extends ConsumerPlugin {
  static id = 'bee-queue'
  static prefix = 'tracing:orchestrion:bee-queue:Queue__runJob'

  asyncEnd (ctx) {
    ctx.currentStore?.span?.finish()
  }

  bindStart (ctx) {
    const job = ctx.arguments?.[0]
    const queueName = job?.queue?.name || 'bee-queue'

    let childOf
    const datadogContext = job?.data?._datadog
    if (datadogContext) {
      childOf = this.tracer.extract('text_map', datadogContext)
    }

    const span = this.startSpan({
      childOf,
      meta: {
        component: 'bee-queue',
        'span.kind': 'consumer',
        'messaging.system': 'bee-queue',
        'messaging.destination.name': queueName,
        'messaging.operation': 'process'
      }
    }, ctx)

    if (this.config.dsmEnabled) {
      this.setConsumerCheckpoint(span, ctx)
    }

    return ctx.currentStore
  }

  setConsumerCheckpoint (span, ctx) {
    const job = ctx.arguments?.[0]
    if (!job) return

    const queueName = job.queue?.name || 'bee-queue'
    const payloadSize = job.data ? getMessageSize(job.data) : 0

    const datadogContext = job.data?._datadog
    if (datadogContext) {
      this.tracer.decodeDataStreamsContext(datadogContext)
    }

    const edgeTags = ['direction:in', `topic:${queueName}`, 'type:bee-queue']
    this.tracer.setCheckpoint(edgeTags, span, payloadSize)
  }

  getTags (ctx) {
    return {
      component: 'bee-queue',
      'span.kind': 'consumer',
      'messaging.system': 'bee-queue',
      'messaging.destination.name': ctx.arguments?.[0]?.queue?.name,
      'messaging.operation': 'process'
    }
  }

}

module.exports = BeeQueueConsumerPlugin
