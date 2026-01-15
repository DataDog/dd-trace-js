'use strict'

const ProducerPlugin = require('../../dd-trace/src/plugins/producer')
const { DsmPathwayCodec, getMessageSize } = require('../../dd-trace/src/datastreams')

class BaseBeeQueueProducerPlugin extends ProducerPlugin {
  static id = 'bee-queue'
  static prefix = 'tracing:orchestrion:bee-queue:Job_save'
  static peerServicePrecursors = ['messaging.destination.name']

  asyncEnd (ctx) {
    const span = ctx.currentStore?.span
    if (span) {
      this.tagPeerService(span)
      span.finish()
    }
  }

  bindStart (ctx) {
    const meta = this.getTags(ctx)

    const span = this.startSpan({
      meta
    }, ctx)

    // Inject trace context for distributed tracing
    this.injectTraceContext(span, ctx)

    if (this.config.dsmEnabled) {
      this.setProducerCheckpoint(span, ctx)
    }

    return ctx.currentStore
  }

  injectTraceContext (span, ctx) {
    const jobData = ctx.self?.data
    if (jobData && typeof jobData === 'object') {
      jobData._datadog = jobData._datadog || {}
      this.tracer.inject(span, 'text_map', jobData._datadog)
    }
  }

  getTags (ctx) {
    return {
      component: 'bee-queue',
      'span.kind': 'producer',
      'messaging.system': 'bee-queue',
      'messaging.destination.name': ctx.self?.queue?.name,
      'messaging.operation': 'produce'
    }
  }

  setProducerCheckpoint (span, ctx) {
    const queueName = ctx.self?.queue?.name || 'bee-queue'
    const jobData = ctx.self?.data
    const payloadSize = jobData ? getMessageSize(jobData) : 0

    const edgeTags = ['direction:out', `topic:${queueName}`, 'type:bee-queue']
    const dataStreamsContext = this.tracer.setCheckpoint(edgeTags, span, payloadSize)

    // Inject DSM context into job data for propagation
    if (jobData && typeof jobData === 'object') {
      jobData._datadog = jobData._datadog || {}
      DsmPathwayCodec.encode(dataStreamsContext, jobData._datadog)
    }
  }
}

class QueueSaveAllPlugin extends BaseBeeQueueProducerPlugin {
  static prefix = 'tracing:orchestrion:bee-queue:Queue_saveAll'

  getTags (ctx) {
    const tags = {
      component: 'bee-queue',
      'span.kind': 'producer',
      'messaging.system': 'bee-queue',
      'messaging.destination.name': ctx.self?.name,
      'messaging.operation': 'produce'
    }

    // Add batch message count if jobs array is available
    const jobs = ctx.arguments?.[0]
    if (Array.isArray(jobs)) {
      tags['messaging.batch.message_count'] = String(jobs.length)
    }

    return tags
  }

  injectTraceContext (span, ctx) {
    const jobs = ctx.arguments?.[0]
    if (!Array.isArray(jobs)) return
    for (const job of jobs) {
      const jobData = job?.data
      if (jobData && typeof jobData === 'object') {
        jobData._datadog = jobData._datadog || {}
        this.tracer.inject(span, 'text_map', jobData._datadog)
      }
    }
  }

  setProducerCheckpoint (span, ctx) {
    const jobs = ctx.arguments?.[0] || []
    const queueName = ctx.self?.name || 'bee-queue'
    const edgeTags = ['direction:out', `topic:${queueName}`, 'type:bee-queue']

    for (const job of jobs) {
      const jobData = job?.data
      if (jobData && typeof jobData === 'object') {
        const payloadSize = getMessageSize(jobData)
        const dataStreamsContext = this.tracer.setCheckpoint(edgeTags, span, payloadSize)
        jobData._datadog = jobData._datadog || {}
        DsmPathwayCodec.encode(dataStreamsContext, jobData._datadog)
      }
    }
  }
}

module.exports = {
  BaseBeeQueueProducerPlugin,
  QueueSaveAllPlugin
}
