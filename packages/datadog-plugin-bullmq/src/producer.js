'use strict'

const { DsmPathwayCodec, getMessageSize } = require('../../dd-trace/src/datastreams')
const log = require('../../dd-trace/src/log')
const { argument, field } = require('../../dd-trace/src/plugins/orchestrion-pipeline')

const producerTags = {
  component: 'bullmq',
  'span.kind': 'producer',
  'messaging.system': 'bullmq',
  'messaging.operation': 'publish',
}

/**
 * Parse BullMQ telemetry metadata without allowing customer-controlled JSON to break publishing.
 *
 * @param {unknown} raw
 * @returns {Record<string, unknown>}
 */
function parseTelemetryMetadata (raw) {
  if (typeof raw !== 'string' || raw.length === 0) return {}
  try {
    const metadata = JSON.parse(raw)
    return metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}
  } catch (error) {
    log.warn('bullmq: ignoring malformed telemetry.metadata: %s', error.message)
    return {}
  }
}

/**
 * Add trace propagation to BullMQ telemetry metadata.
 *
 * @param {import('../../dd-trace/src/plugins/orchestrion-pipeline').PipelineFrame} frame
 * @param {object} opts
 * @returns {Record<string, unknown>}
 */
function injectIntoOpts (frame, opts) {
  const carrier = {}
  frame.tracer.inject(frame.span, 'text_map', carrier)
  const metadata = parseTelemetryMetadata(opts.telemetry?.metadata)
  metadata._datadog = carrier
  opts.telemetry = { metadata: JSON.stringify(metadata), omitContext: true }
  return metadata
}

/**
 * Ensure Queue.add has a mutable options argument.
 *
 * @param {import('../../dd-trace/src/plugins/orchestrion-pipeline').OrchestrionContext} context
 * @returns {object}
 */
function ensureQueueOpts (context) {
  let opts = context.arguments[2]
  if (!opts || typeof opts !== 'object') {
    opts = {}
    if (context.arguments.length <= 2) {
      Array.prototype.push.call(context.arguments, opts)
    } else {
      context.arguments[2] = opts
    }
  }
  return opts
}

/**
 * Run a producer filter without allowing user code to break the instrumented operation.
 *
 * @param {import('../../dd-trace/src/plugins/orchestrion-pipeline').PipelineFrame} frame
 * @param {object} job
 * @returns {boolean}
 */
function shouldInstrument (frame, job) {
  const filter = frame.config.producerFilter
  if (!filter) return true
  try {
    return filter(job)
  } catch (error) {
    log.error('bullmq: producerFilter threw, filtering is disabled: %s', error.message)
    return true
  }
}

/**
 * Select jobs accepted by the configured bulk filter.
 *
 * @param {import('../../dd-trace/src/plugins/orchestrion-pipeline').OrchestrionContext} context
 * @param {import('../../dd-trace/src/plugins/orchestrion-pipeline').PipelineFrame} frame
 * @returns {object[] | undefined}
 */
function extractBulkJobs (context, frame) {
  const jobs = context.arguments[0]
  if (!Array.isArray(jobs)) return

  const filter = frame.config.producerFilter
  if (!filter) return jobs

  const allowedJobs = []
  const queueName = context.self?.name
  try {
    for (const job of jobs) {
      if (job && filter({ name: job.name, data: job.data, opts: job.opts, queueName })) {
        allowedJobs.push(job)
      }
    }
  } catch (error) {
    log.error('bullmq: producerFilter threw, filtering is disabled: %s', error.message)
    for (const job of jobs) {
      if (job) allowedJobs.push(job)
    }
  }
  return allowedJobs
}

/**
 * Resolve the messaging producer service using the existing naming schema.
 *
 * @param {import('../../dd-trace/src/plugins/orchestrion-pipeline').PipelineFrame} frame
 * @returns {string | {name: string, source?: string}}
 */
function producerService (frame) {
  return frame.config.service || frame.plugin.serviceName({ type: 'messaging', kind: 'producer' })
}

const queuePropagationStage = {
  name: 'trace-propagation',
  start (frame) {
    frame.data.metadata = injectIntoOpts(frame, ensureQueueOpts(frame.context))
  },
}

const bulkPropagationStage = {
  name: 'trace-propagation',
  start (frame) {
    const jobs = frame.data.jobs
    if (!jobs) return

    const metadata = new Array(jobs.length)
    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i]
      if (!job) continue
      job.opts ||= {}
      metadata[i] = injectIntoOpts(frame, job.opts)
    }
    frame.data.metadata = metadata
  },
}

const flowPropagationStage = {
  name: 'trace-propagation',
  start (frame) {
    const flow = frame.data.flow
    if (!flow) return
    flow.opts ||= {}
    frame.data.metadata = injectIntoOpts(frame, flow.opts)
  },
}

const queueDsmStage = {
  name: 'data-streams',
  start (frame) {
    if (!frame.config.dsmEnabled) return

    const queueName = frame.data.queueName
    const payloadSize = frame.data.data ? getMessageSize(frame.data.data) : 0
    const pathway = frame.tracer.setCheckpoint(
      ['direction:out', `topic:${queueName}`, 'type:bullmq'],
      frame.span,
      payloadSize
    )
    const opts = ensureQueueOpts(frame.context)
    const metadata = frame.data.metadata || parseTelemetryMetadata(opts.telemetry?.metadata)
    DsmPathwayCodec.encode(pathway, metadata._datadog || metadata)
    if (!metadata._datadog) metadata._datadog = {}
    opts.telemetry = { metadata: JSON.stringify(metadata), omitContext: true }
  },
}

const bulkDsmStage = {
  name: 'data-streams',
  start (frame) {
    if (!frame.config.dsmEnabled) return

    const jobs = frame.data.jobs || []
    const edgeTags = ['direction:out', `topic:${frame.data.queueName}`, 'type:bullmq']
    const cache = frame.data.metadata
    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i]
      if (!job?.data) continue
      const pathway = frame.tracer.setCheckpoint(edgeTags, frame.span, getMessageSize(job.data))
      const metadata = cache?.[i] || parseTelemetryMetadata(job.opts.telemetry?.metadata)
      DsmPathwayCodec.encode(pathway, metadata._datadog || metadata)
      if (!metadata._datadog) metadata._datadog = {}
      job.opts.telemetry = { metadata: JSON.stringify(metadata), omitContext: true }
    }
  },
}

const flowDsmStage = {
  name: 'data-streams',
  start (frame) {
    if (!frame.config.dsmEnabled) return

    const flow = frame.data.flow
    if (!flow) return
    flow.opts ||= {}
    const queueName = flow.queueName || 'bullmq'
    const pathway = frame.tracer.setCheckpoint(
      ['direction:out', `topic:${queueName}`, 'type:bullmq'],
      frame.span,
      flow.data ? getMessageSize(flow.data) : 0
    )
    const metadata = frame.data.metadata || parseTelemetryMetadata(flow.opts.telemetry?.metadata)
    DsmPathwayCodec.encode(pathway, metadata._datadog || metadata)
    if (!metadata._datadog) metadata._datadog = {}
    flow.opts.telemetry = { metadata: JSON.stringify(metadata), omitContext: true }
  },
}

const operations = [
  {
    target: { module: 'bullmq', name: 'Queue_add' },
    lifecycle: 'async',
    skip: 'noop',
    extract: {
      start: {
        name: argument(0),
        data: argument(1),
        opts: argument(2),
        queueName: context => context.self?.name || 'bullmq',
      },
    },
    when: frame => shouldInstrument(frame, {
      name: frame.data.name,
      data: frame.data.data,
      opts: frame.data.opts,
      queueName: frame.context.self?.name,
    }),
    span: {
      name: 'bullmq.add',
      service: producerService,
      resource: field('queueName'),
      type: 'messaging',
      kind: 'producer',
      tags: {
        ...producerTags,
        'messaging.destination.name': field('queueName'),
      },
    },
    stages: [queuePropagationStage, queueDsmStage],
  },
  {
    target: { module: 'bullmq', name: 'Queue_addBulk' },
    lifecycle: 'async',
    skip: 'noop',
    extract: {
      start: {
        rawJobs: argument(0),
        jobs: extractBulkJobs,
        queueName: context => context.self?.name || 'bullmq',
      },
    },
    when: frame => frame.data.jobs === undefined || frame.data.jobs.length > 0 || frame.data.rawJobs.length === 0,
    span: {
      name: 'bullmq.addBulk',
      service: producerService,
      resource: field('queueName'),
      type: 'messaging',
      kind: 'producer',
      tags: {
        ...producerTags,
        'messaging.destination.name': field('queueName'),
        'messaging.batch.message_count': frame => frame.data.rawJobs?.length,
      },
    },
    stages: [bulkPropagationStage, bulkDsmStage],
  },
  {
    target: { module: 'bullmq', name: 'FlowProducer_add' },
    lifecycle: 'async',
    skip: 'noop',
    extract: {
      start: {
        flow: argument(0),
        queueName: context => context.arguments[0]?.queueName || 'bullmq',
      },
    },
    when: frame => shouldInstrument(frame, {
      name: frame.data.flow?.name,
      data: frame.data.flow?.data,
      opts: frame.data.flow?.opts,
      queueName: frame.data.flow?.queueName,
    }),
    span: {
      name: 'bullmq.add',
      service: producerService,
      resource: field('queueName'),
      type: 'messaging',
      kind: 'producer',
      tags: {
        ...producerTags,
        'messaging.destination.name': frame => frame.data.flow?.queueName,
      },
    },
    stages: [flowPropagationStage, flowDsmStage],
  },
]

module.exports = operations
module.exports.parseTelemetryMetadata = parseTelemetryMetadata
