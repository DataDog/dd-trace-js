'use strict'

const { TEXT_MAP } = require('../../../ext/formats')
const ConsumerPlugin = require('../../dd-trace/src/plugins/consumer')
const { getSizeOrZero } = require('../../dd-trace/src/datastreams')

class BeeQueueConsumerPlugin extends ConsumerPlugin {
  static id = 'bee-queue'
  static prefix = 'tracing:orchestrion:bee-queue:Queue__runJob'

  operationName () {
    return 'bee-queue._runJob'
  }

  bindStart (ctx) {
    const meta = this.getTags(ctx)
    const job = ctx.arguments?.[0]
    const queueName = job?.queue?.name
    const jobData = job?.data

    let childOf
    if (jobData?._datadog) {
      childOf = this.tracer.extract(TEXT_MAP, jobData._datadog)
    }

    const span = this.startSpan({
      childOf,
      meta,
      type: 'worker'
    }, ctx)

    if (this.config.dsmEnabled && queueName && jobData?._datadog) {
      const payloadSize = getJobPayloadSize(jobData)
      this.tracer.decodeDataStreamsContext(jobData._datadog)
      const edgeTags = ['direction:in', `topic:${queueName}`, 'type:bee-queue']
      this.tracer.setCheckpoint(edgeTags, span, payloadSize)
    }

    return ctx.currentStore
  }

  bindAsyncStart (ctx) {
    return ctx.currentStore
  }

  getTags (ctx) {
    return {
      component: 'bee-queue',
      'span.kind': 'consumer',
      'messaging.system': 'bee-queue',
      'messaging.destination.name': ctx.arguments?.[0].queue.name,
      'messaging.operation': 'process'
    }
  }

  asyncEnd (ctx) {
    this.finish(ctx)
  }

  end (ctx) {
    this.finish(ctx)
  }

  finish (ctx) {
    // CRITICAL GUARD - DO NOT REMOVE: Ensures span only finishes when operation completes
    if (!ctx.hasOwnProperty('result') && !ctx.hasOwnProperty('error')) return

    if (ctx.result && Array.isArray(ctx.result)) {
      const [status, result] = ctx.result
      if ((status === 'failed' || status === 'retrying') && result) {
        const span = ctx.currentStore?.span
        if (span) {
          span.setTag('error', result)
        }
      }
    }

    super.finish(ctx)
  }
}

function getJobPayloadSize (data) {
  if (data == null) return 0
  try {
    return getSizeOrZero(JSON.stringify(data))
  } catch {
    return 0
  }
}

module.exports = BeeQueueConsumerPlugin
