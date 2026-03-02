'use strict'

const ConsumerPlugin = require('../../dd-trace/src/plugins/consumer')
const { getMessageSize } = require('../../dd-trace/src/datastreams')

class BullmqConsumerPlugin extends ConsumerPlugin {
  static id = 'bullmq'
  static prefix = 'tracing:orchestrion:bullmq:Worker_callProcessJob'

  asyncEnd (ctx) {
    ctx.currentStore?.span?.finish()
  }

  start (ctx) {
    if (!this.config.dsmEnabled) return
    const { span } = ctx.currentStore
    this.setConsumerCheckpoint(span, ctx)
  }

  bindStart (ctx) {
    const job = ctx.arguments?.[0]
    const queueName = job?.queueName || job?.queue?.name || 'bullmq'

    let childOf
    const datadogContext = job?.data?._datadog
    if (datadogContext) {
      childOf = this.tracer.extract('text_map', datadogContext)
    }

    this.startSpan({
      childOf,
      resource: queueName,
      meta: {
        component: 'bullmq',
        'span.kind': 'consumer',
        'messaging.system': 'bullmq',
        'messaging.destination.name': queueName,
        'messaging.operation': 'process',
      },
    }, ctx)

    return ctx.currentStore
  }

  setConsumerCheckpoint (span, ctx) {
    const job = ctx.arguments?.[0]
    if (!job) return

    const queueName = job.queueName || job.queue?.name || 'bullmq'
    const payloadSize = job.data ? getMessageSize(job.data) : 0

    const datadogContext = job.data?._datadog
    if (datadogContext) {
      this.tracer.decodeDataStreamsContext(datadogContext)
    }

    const edgeTags = ['direction:in', `topic:${queueName}`, 'type:bullmq']
    this.tracer.setCheckpoint(edgeTags, span, payloadSize)
  }
}

module.exports = BullmqConsumerPlugin
