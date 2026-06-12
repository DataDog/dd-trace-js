'use strict'

const log = require('../../dd-trace/src/log')
const ProducerPlugin = require('../../dd-trace/src/plugins/producer')
const { DsmPathwayCodec, getMessageSize } = require('../../dd-trace/src/datastreams')
const { getFilter } = require('./filter')

const filteredJobs = Symbol('bullmq.filteredJobs')

// Customer-controlled metadata may be malformed JSON. Returning a fresh `{}`
// on parse failure keeps the publish path alive instead of throwing into
// `Queue.add` / `Queue.addBulk`.
function parseTelemetryMetadata (raw) {
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch (error) {
    log.warn('bullmq: ignoring malformed telemetry.metadata: %s', error.message)
    return {}
  }
}

class BaseBullmqProducerPlugin extends ProducerPlugin {
  static id = 'bullmq'

  asyncEnd (ctx) {
    ctx.currentStore?.span?.finish()
  }

  start (ctx) {
    if (!this.config.dsmEnabled) return
    const { span } = ctx.currentStore
    this.setProducerCheckpoint(span, ctx)
  }

  bindStart (ctx) {
    let instrument = true
    if (this.config.producerFilter) {
      try {
        instrument = this.shouldInstrument(ctx)
      } catch (error) {
        log.error('bullmq: producerFilter threw, filtering is disabled: %s', error.message)
      }
    }

    if (!instrument) {
      return { noop: true }
    }

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

    return ctx.currentStore
  }

  configure (config) {
    if (typeof config === 'boolean') {
      return super.configure(config)
    }
    return super.configure({ ...config, producerFilter: getFilter(config) })
  }

  shouldInstrument (ctx) {
    throw new Error('shouldInstrument must be implemented by subclass')
  }

  getSpanData (ctx) {
    throw new Error('getSpanData must be implemented by subclass')
  }

  injectTraceContext (span, ctx) {
    throw new Error('injectTraceContext must be implemented by subclass')
  }

  // Returned so setProducerCheckpoint can mutate it without a second parse.
  _injectIntoOpts (span, opts) {
    const carrier = {}
    this.tracer.inject(span, 'text_map', carrier)
    const metadata = parseTelemetryMetadata(opts.telemetry?.metadata)
    metadata._datadog = carrier
    opts.telemetry = { metadata: JSON.stringify(metadata), omitContext: true }
    return metadata
  }

  setProducerCheckpoint (span, ctx) {
    const { queueName, payloadSize, optsTarget } = this.getDsmData(ctx)
    const edgeTags = ['direction:out', `topic:${queueName}`, 'type:bullmq']
    const dataStreamsContext = this.tracer.setCheckpoint(edgeTags, span, payloadSize)

    if (optsTarget && typeof optsTarget === 'object') {
      const metadata = ctx._ddMetadata ?? parseTelemetryMetadata(optsTarget.telemetry?.metadata)
      DsmPathwayCodec.encode(dataStreamsContext, metadata._datadog || metadata)
      if (!metadata._datadog) metadata._datadog = {}
      optsTarget.telemetry = { metadata: JSON.stringify(metadata), omitContext: true }
    }
  }

  getDsmData (ctx) {
    throw new Error('getDsmData must be implemented by subclass')
  }
}

class QueueAddPlugin extends BaseBullmqProducerPlugin {
  static prefix = 'tracing:orchestrion:bullmq:Queue_add'

  shouldInstrument (ctx) {
    return this.config.producerFilter({
      name: ctx.arguments?.[0],
      data: ctx.arguments?.[1],
      opts: ctx.arguments?.[2],
      queueName: ctx.self?.name,
    })
  }

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
    const opts = this.#ensureOpts(ctx)
    ctx._ddMetadata = this._injectIntoOpts(span, opts)
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

  shouldInstrument (ctx) {
    const jobs = this.#getFilteredJobs(ctx)
    // Empty bulk calls are publish attempts and should keep producing a span.
    return jobs === undefined || jobs.length > 0 || ctx.arguments?.[0].length === 0
  }

  #getFilteredJobs (ctx) {
    if (Object.hasOwn(ctx, filteredJobs)) return ctx[filteredJobs]

    const jobs = ctx.arguments?.[0]
    if (!Array.isArray(jobs)) return

    let allowedJobs
    if (this.config.producerFilter) {
      const queueName = ctx.self?.name
      try {
        allowedJobs = []
        for (const job of jobs) {
          if (job && this.config.producerFilter({ name: job.name, data: job.data, opts: job.opts, queueName })) {
            allowedJobs.push(job)
          }
        }
      } catch (error) {
        log.error('bullmq: producerFilter threw, filtering is disabled: %s', error.message)
        allowedJobs = jobs.filter(Boolean)
      }
    } else {
      allowedJobs = jobs
    }

    ctx[filteredJobs] = allowedJobs
    return allowedJobs
  }

  operationName () {
    return 'bullmq.addBulk'
  }

  getSpanData (ctx) {
    const queueName = ctx.self?.name || 'bullmq'
    const jobs = this.#getFilteredJobs(ctx)
    return {
      resource: queueName,
      meta: {
        'messaging.destination.name': ctx.self?.name,
        'messaging.batch.message_count': jobs?.length,
      },
    }
  }

  injectTraceContext (span, ctx) {
    const jobs = this.#getFilteredJobs(ctx)
    if (!jobs) return

    const cache = []
    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i]
      if (!job) continue
      job.opts = job.opts || {}
      cache[i] = this._injectIntoOpts(span, job.opts)
    }
    ctx._ddMetadata = cache
  }

  setProducerCheckpoint (span, ctx) {
    const jobs = this.#getFilteredJobs(ctx) || []
    const queueName = ctx.self?.name || 'bullmq'
    const edgeTags = ['direction:out', `topic:${queueName}`, 'type:bullmq']
    const cache = ctx._ddMetadata

    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i]
      if (!job?.data) continue
      const payloadSize = getMessageSize(job.data)
      const dataStreamsContext = this.tracer.setCheckpoint(edgeTags, span, payloadSize)
      const metadata = cache?.[i] ?? parseTelemetryMetadata(job.opts.telemetry?.metadata)
      DsmPathwayCodec.encode(dataStreamsContext, metadata._datadog || metadata)
      if (!metadata._datadog) metadata._datadog = {}
      job.opts.telemetry = { metadata: JSON.stringify(metadata), omitContext: true }
    }
  }
}

class FlowProducerAddPlugin extends BaseBullmqProducerPlugin {
  static prefix = 'tracing:orchestrion:bullmq:FlowProducer_add'

  shouldInstrument (ctx) {
    const flow = ctx.arguments?.[0]
    return this.config.producerFilter({
      name: flow?.name,
      data: flow?.data,
      opts: flow?.opts,
      queueName: flow?.queueName,
    })
  }

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
    flow.opts = flow.opts || {}
    ctx._ddMetadata = this._injectIntoOpts(span, flow.opts)
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
