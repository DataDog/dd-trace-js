'use strict'

const { TEXT_MAP } = require('../../../ext/formats')
const ProducerPlugin = require('../../dd-trace/src/plugins/producer')
const { DsmPathwayCodec, getSizeOrZero } = require('../../dd-trace/src/datastreams')

class BaseBeeQueueProducerPlugin extends ProducerPlugin {
  static id = 'bee-queue'
  static prefix = 'tracing:orchestrion:bee-queue:Job_save'
  static peerServicePrecursors = ['messaging.destination.name']

  operationName () {
    return 'bee-queue.save'
  }

  bindStart (ctx) {
    const meta = this.getTags(ctx)
    const queueName = ctx.self?.queue?.name

    const span = this.startSpan({
      meta
    }, ctx)

    if (ctx.self?.data && ctx.self.data !== null && typeof ctx.self.data === 'object') {
      ctx.self.data._datadog = ctx.self.data._datadog || {}
      this.tracer.inject(span, TEXT_MAP, ctx.self.data._datadog)
    }

    if (this.config.dsmEnabled && queueName) {
      const payloadSize = getJobPayloadSize(ctx.self?.data)
      const edgeTags = ['direction:out', `topic:${queueName}`, 'type:bee-queue']
      const dataStreamsContext = this.tracer.setCheckpoint(edgeTags, span, payloadSize)

      if (ctx.self?.data && ctx.self.data !== null && typeof ctx.self.data === 'object') {
        DsmPathwayCodec.encode(dataStreamsContext, ctx.self.data._datadog)
      }
    }

    return ctx.currentStore
  }

  getTags (ctx) {
    return {
      component: 'bee-queue',
      'span.kind': 'producer',
      'messaging.system': 'bee-queue',
      'messaging.destination.name': ctx.self?.queue.name,
      'messaging.operation': 'produce'
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

    super.finish(ctx)
  }
}

class QueueSaveAllPlugin extends BaseBeeQueueProducerPlugin {
  static prefix = 'tracing:orchestrion:bee-queue:Queue_saveAll'

  operationName () {
    return 'bee-queue.saveAll'
  }

  bindStart (ctx) {
    const meta = this.getTags(ctx)
    const queueName = ctx.self?.name

    const span = this.startSpan({
      meta
    }, ctx)

    const jobs = ctx.arguments?.[0]
    if (Array.isArray(jobs)) {
      for (const job of jobs) {
        if (job?.data && job.data !== null && typeof job.data === 'object') {
          job.data._datadog = job.data._datadog || {}
          this.tracer.inject(span, TEXT_MAP, job.data._datadog)
        }

        if (this.config.dsmEnabled && queueName) {
          const payloadSize = getJobPayloadSize(job?.data)
          const edgeTags = ['direction:out', `topic:${queueName}`, 'type:bee-queue']
          const dataStreamsContext = this.tracer.setCheckpoint(edgeTags, span, payloadSize)

          if (job?.data && job.data !== null && typeof job.data === 'object') {
            DsmPathwayCodec.encode(dataStreamsContext, job.data._datadog)
          }
        }
      }
    }

    return ctx.currentStore
  }

  getTags (ctx) {
    const jobs = ctx.arguments?.[0]
    const batchCount = Array.isArray(jobs) ? jobs.length : 0

    return {
      component: 'bee-queue',
      'span.kind': 'producer',
      'messaging.system': 'bee-queue',
      'messaging.destination.name': ctx.self?.name,
      'messaging.operation': 'produce',
      'messaging.batch.message_count': String(batchCount)
    }
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

module.exports = {
  BaseBeeQueueProducerPlugin,
  QueueSaveAllPlugin
}
