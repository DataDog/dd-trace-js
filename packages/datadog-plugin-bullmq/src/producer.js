'use strict'

const ProducerPlugin = require('../../dd-trace/src/plugins/producer')
const { DsmPathwayCodec, getMessageSize } = require('../../dd-trace/src/datastreams')

class BaseBullmqProducerPlugin extends ProducerPlugin {
  static id = 'bullmq'

  asyncEnd (ctx) {
    ctx.currentStore?.span?.finish()
  }

  bindStart (ctx) {
    const { resource, meta } = this.getSpanData(ctx)
    const span = this.startSpan({
      resource,
      meta: {
        component: 'bullmq',
        'span.kind': 'producer',
        'messaging.system': 'bullmq',
        'messaging.operation': 'publish',
        ...meta,
      },
    }, ctx)

    this.injectTraceContext(span, ctx)

    if (this.config.dsmEnabled) {
      this.setProducerCheckpoint(span, ctx)
    }

    return ctx.currentStore
  }

  getSpanData (ctx) {
    throw new Error('getSpanData must be implemented by subclass')
  }

  injectTraceContext (span, ctx) {
    throw new Error('injectTraceContext must be implemented by subclass')
  }

  setProducerCheckpoint (span, ctx) {
    const { queueName, payloadSize, injectTarget } = this.getDsmData(ctx)
    const edgeTags = ['direction:out', `topic:${queueName}`, 'type:bullmq']
    const dataStreamsContext = this.tracer.setCheckpoint(edgeTags, span, payloadSize)
    if (injectTarget && typeof injectTarget === 'object') {
      injectTarget._datadog = injectTarget._datadog || {}
      DsmPathwayCodec.encode(dataStreamsContext, injectTarget._datadog)
    }
  }

  getDsmData (ctx) {
    throw new Error('getDsmData must be implemented by subclass')
  }
}

class QueueAddPlugin extends BaseBullmqProducerPlugin {
  static prefix = 'tracing:orchestrion:bullmq:Queue_add'

  getSpanData (ctx) {
    const queueName = ctx.self?.name || 'bullmq'
    return {
      resource: queueName,
      meta: {
        'messaging.destination.name': ctx.self?.name,
      },
    }
  }

  injectTraceContext (span, ctx) {
    const data = ctx.arguments?.[1]
    if (data?.constructor?.name === 'Object') {
      data._datadog = data._datadog || {}
      this.tracer.inject(span, 'text_map', data._datadog)
    }
  }

  getDsmData (ctx) {
    const data = ctx.arguments?.[1]
    return {
      queueName: ctx.self?.name || 'bullmq',
      payloadSize: data ? getMessageSize(data) : 0,
      injectTarget: data,
    }
  }
}

class QueueAddBulkPlugin extends BaseBullmqProducerPlugin {
  static prefix = 'tracing:orchestrion:bullmq:Queue_addBulk'

  operationName () {
    return 'bullmq.addBulk'
  }

  getSpanData (ctx) {
    const queueName = ctx.self?.name || 'bullmq'
    const jobs = ctx.arguments?.[0]
    return {
      resource: queueName,
      meta: {
        'messaging.destination.name': ctx.self?.name,
        'messaging.batch.message_count': Array.isArray(jobs) ? jobs.length : undefined,
      },
    }
  }

  injectTraceContext (span, ctx) {
    const jobs = ctx.arguments?.[0]
    if (!Array.isArray(jobs)) return
    for (const job of jobs) {
      if (job?.data?.constructor?.name !== 'Object') continue
      job.data._datadog = job.data._datadog || {}
      this.tracer.inject(span, 'text_map', job.data._datadog)
    }
  }

  getDsmData (ctx) {
    const jobs = ctx.arguments?.[0] || []
    const payloadSize = jobs.reduce((total, job) => {
      return total + (job?.data ? getMessageSize(job.data) : 0)
    }, 0)
    return {
      queueName: ctx.self?.name || 'bullmq',
      payloadSize,
      injectTarget: jobs[0]?.data,
    }
  }

  setProducerCheckpoint (span, ctx) {
    const jobs = ctx.arguments?.[0] || []
    const queueName = ctx.self?.name || 'bullmq'
    const edgeTags = ['direction:out', `topic:${queueName}`, 'type:bullmq']

    for (const job of jobs) {
      if (job?.data && job.data !== null && job.data.constructor.name === 'Object') {
        const payloadSize = getMessageSize(job.data)
        const dataStreamsContext = this.tracer.setCheckpoint(edgeTags, span, payloadSize)
        job.data._datadog = job.data._datadog || {}
        DsmPathwayCodec.encode(dataStreamsContext, job.data._datadog)
      }
    }
  }
}

class FlowProducerAddPlugin extends BaseBullmqProducerPlugin {
  static prefix = 'tracing:orchestrion:bullmq:FlowProducer_add'

  getSpanData (ctx) {
    const flow = ctx.arguments?.[0]
    const queueName = flow?.queueName || 'bullmq'
    return {
      resource: queueName,
      meta: {
        'messaging.destination.name': flow?.queueName,
      },
    }
  }

  injectTraceContext (span, ctx) {
    const flow = ctx.arguments?.[0]
    if (flow?.data?.constructor?.name === 'Object') {
      flow.data._datadog = flow.data._datadog || {}
      this.tracer.inject(span, 'text_map', flow.data._datadog)
    }
  }

  getDsmData (ctx) {
    const flow = ctx.arguments?.[0]
    return {
      queueName: flow?.queueName || 'bullmq',
      payloadSize: flow?.data ? getMessageSize(flow.data) : 0,
      injectTarget: flow?.data,
    }
  }
}

module.exports = [QueueAddPlugin, QueueAddBulkPlugin, FlowProducerAddPlugin]
