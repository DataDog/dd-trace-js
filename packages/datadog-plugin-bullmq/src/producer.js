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
    const { queueName, payloadSize, optsTarget } = this.getDsmData(ctx)
    const edgeTags = ['direction:out', `topic:${queueName}`, 'type:bullmq']
    const dataStreamsContext = this.tracer.setCheckpoint(edgeTags, span, payloadSize)

    if (optsTarget && typeof optsTarget === 'object') {
      const existing = optsTarget.telemetry?.metadata ? JSON.parse(optsTarget.telemetry.metadata) : {}
      DsmPathwayCodec.encode(dataStreamsContext, existing)
      optsTarget.telemetry = { metadata: JSON.stringify(existing), omitContext: true }
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

  #ensureOpts (ctx) {
    let opts = ctx.arguments?.[2]
    if (!opts || typeof opts !== 'object') {
      opts = {}
      if (ctx.arguments.length <= 2) {
        Array.prototype.push.call(ctx.arguments, opts)
      } else {
        ctx.arguments[2] = opts
      }
    }
    return opts
  }

  injectTraceContext (span, ctx) {
    const carrier = {}
    this.tracer.inject(span, 'text_map', carrier)
    const opts = this.#ensureOpts(ctx)
    opts.telemetry = { metadata: JSON.stringify(carrier), omitContext: true }
  }

  getDsmData (ctx) {
    const data = ctx.arguments?.[1]
    return {
      queueName: ctx.self?.name || 'bullmq',
      payloadSize: data ? getMessageSize(data) : 0,
      optsTarget: this.#ensureOpts(ctx),
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
    const carrier = {}
    this.tracer.inject(span, 'text_map', carrier)
    const metadata = JSON.stringify(carrier)

    for (const job of jobs) {
      if (!job) continue
      job.opts = job.opts || {}
      job.opts.telemetry = { metadata, omitContext: true }
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
      optsTarget: jobs[0]?.opts,
    }
  }

  setProducerCheckpoint (span, ctx) {
    const jobs = ctx.arguments?.[0] || []
    const queueName = ctx.self?.name || 'bullmq'
    const edgeTags = ['direction:out', `topic:${queueName}`, 'type:bullmq']

    for (const job of jobs) {
      if (!job?.data) continue
      const payloadSize = getMessageSize(job.data)
      const dataStreamsContext = this.tracer.setCheckpoint(edgeTags, span, payloadSize)
      job.opts = job.opts || {}
      const existing = job.opts.telemetry?.metadata ? JSON.parse(job.opts.telemetry.metadata) : {}
      DsmPathwayCodec.encode(dataStreamsContext, existing)
      job.opts.telemetry = { metadata: JSON.stringify(existing), omitContext: true }
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
    if (!flow) return
    const carrier = {}
    this.tracer.inject(span, 'text_map', carrier)
    flow.opts = flow.opts || {}
    flow.opts.telemetry = { metadata: JSON.stringify(carrier), omitContext: true }
  }

  getDsmData (ctx) {
    const flow = ctx.arguments?.[0]
    if (!flow) {
      return { queueName: 'bullmq', payloadSize: 0, optsTarget: undefined }
    }
    flow.opts = flow.opts || {}
    return {
      queueName: flow.queueName || 'bullmq',
      payloadSize: flow.data ? getMessageSize(flow.data) : 0,
      optsTarget: flow.opts,
    }
  }
}

module.exports = [QueueAddPlugin, QueueAddBulkPlugin, FlowProducerAddPlugin]
