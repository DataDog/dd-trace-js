'use strict'

const log = require('../../dd-trace/src/log')
const { argument, data } = require('../../dd-trace/src/plugins/integration-pipeline')
const { exitCodeOrigin } = require('../../dd-trace/src/plugins/stages/code-origin')
const { createMessagingStage } = require('../../dd-trace/src/plugins/stages/messaging')

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
 * Create the detached carrier the pipeline injects correlation and the DSM pathway into.
 *
 * @returns {Record<string, unknown>}
 */
function newCarrier () {
  return {}
}

/**
 * Persist a completed carrier into BullMQ telemetry metadata, preserving customer fields.
 *
 * @param {object} opts
 * @param {Record<string, unknown>} carrier
 * @returns {void}
 */
function commitCarrier (opts, carrier) {
  const metadata = parseTelemetryMetadata(opts.telemetry?.metadata)
  metadata._datadog = carrier
  opts.telemetry = { metadata: JSON.stringify(metadata), omitContext: true }
}

/**
 * Persist a carrier into a job descriptor or flow node, which may carry no options yet.
 *
 * @param {{opts?: object}} node
 * @param {Record<string, unknown>} carrier
 * @returns {void}
 */
function commitNodeCarrier (node, carrier) {
  node.opts ||= {}
  commitCarrier(node.opts, carrier)
}

/**
 * Ensure Queue.add has a mutable options argument.
 *
 * @param {import('../../dd-trace/src/plugins/integration-pipeline').InvocationContext} context
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
 * @param {import('../../dd-trace/src/plugins/integration-pipeline').PipelineFrame} frame
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
 * @param {import('../../dd-trace/src/plugins/integration-pipeline').InvocationContext} context
 * @param {import('../../dd-trace/src/plugins/integration-pipeline').PipelineFrame} frame
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
 * @param {import('../../dd-trace/src/plugins/integration-pipeline').PipelineFrame} frame
 * @returns {string | {name: string, source?: string}}
 */
function producerService (frame) {
  return frame.serviceName({ type: 'messaging', kind: 'producer' })
}

// Every producer target propagates and checkpoints identically. Only the message set, where its
// carrier is persisted, and which field holds the payload differ.
const outboundMessaging = {
  direction: 'out',
  system: 'bullmq',
  topic: data('queueName'),
  carrier: newCarrier,
}

const queueMessagingStage = createMessagingStage({
  ...outboundMessaging,
  messages: frame => [ensureQueueOpts(frame.invocation)],
  commit: commitCarrier,
  payload: (opts, frame) => frame.data.data,
})

const bulkMessagingStage = createMessagingStage({
  ...outboundMessaging,
  messages: frame => frame.data.jobs,
  commit: commitNodeCarrier,
  payload: job => job.data,
})

const flowMessagingStage = createMessagingStage({
  ...outboundMessaging,
  messages: frame => [frame.data.flow],
  commit: commitNodeCarrier,
  payload: flow => flow.data,
})

const operations = [
  {
    target: { module: 'bullmq', name: 'Queue_add' },
    lifecycle: 'async',
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
      queueName: frame.invocation.self?.name,
    }) || 'noop',
    span: {
      name: 'bullmq.add',
      service: producerService,
      resource: data('queueName'),
      kind: 'producer',
      tags: {
        ...producerTags,
        'messaging.destination.name': data('queueName'),
      },
    },
    stages: [exitCodeOrigin, queueMessagingStage],
  },
  {
    target: { module: 'bullmq', name: 'Queue_addBulk' },
    lifecycle: 'async',
    extract: {
      start: {
        rawJobs: argument(0),
        jobs: extractBulkJobs,
        queueName: context => context.self?.name || 'bullmq',
      },
    },
    when: frame =>
      frame.data.jobs === undefined || frame.data.jobs.length > 0 || frame.data.rawJobs.length === 0 || 'noop',
    span: {
      name: 'bullmq.addBulk',
      service: producerService,
      resource: data('queueName'),
      kind: 'producer',
      tags: {
        ...producerTags,
        'messaging.destination.name': data('queueName'),
        'messaging.batch.message_count': frame => frame.data.rawJobs?.length,
      },
    },
    stages: [exitCodeOrigin, bulkMessagingStage],
  },
  {
    target: { module: 'bullmq', name: 'FlowProducer_add' },
    lifecycle: 'async',
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
    }) || 'noop',
    span: {
      name: 'bullmq.add',
      service: producerService,
      resource: data('queueName'),
      kind: 'producer',
      tags: {
        ...producerTags,
        'messaging.destination.name': frame => frame.data.flow?.queueName,
      },
    },
    stages: [exitCodeOrigin, flowMessagingStage],
  },
]

module.exports = operations
module.exports.parseTelemetryMetadata = parseTelemetryMetadata
