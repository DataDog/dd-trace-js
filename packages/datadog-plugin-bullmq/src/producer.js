'use strict'

const log = require('../../dd-trace/src/log')

/**
 * Parse BullMQ telemetry metadata without allowing customer-controlled JSON to break publishing.
 *
 * @param {unknown} raw Serialized BullMQ telemetry metadata.
 * @returns {Record<string, unknown>} Parsed customer metadata.
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
 * Ensure Queue.add has a mutable options argument.
 *
 * @param {object} context Raw Queue.add invocation.
 * @returns {object} Mutable job options.
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
 * Preserve customer telemetry metadata while writing one Datadog carrier.
 *
 * @param {object} opts Mutable BullMQ job options.
 * @param {Record<string, unknown>} carrier Datadog propagation carrier.
 * @returns {void}
 */
function writeCarrier (opts, carrier) {
  const metadata = parseTelemetryMetadata(opts.telemetry?.metadata)
  metadata._datadog = carrier
  opts.telemetry = { metadata: JSON.stringify(metadata), omitContext: true }
}

/**
 * Normalize one Queue.add invocation.
 *
 * @param {object} context Raw Queue.add invocation.
 * @returns {object} Semantic messaging facts.
 */
function startQueue (context) {
  const [name, data, opts] = context.arguments
  const queueName = context.self?.name

  return {
    action: 'add',
    destination: queueName || 'bullmq',
    filterCount: 1,
    messages: [{
      body: data,
      filter: { data, name, opts, queueName },
      index: 0,
    }],
  }
}

/**
 * Write Queue.add propagation back to its options argument.
 *
 * @param {object} context Raw Queue.add invocation.
 * @param {object} facts Normalized messaging facts.
 * @param {{carriers: Array<{carrier: object}>}} updates Processor-owned carrier updates.
 * @returns {void}
 */
function updateQueue (context, facts, updates) {
  writeCarrier(ensureQueueOpts(context), updates.carriers[0].carrier)
}

/**
 * Normalize one Queue.addBulk invocation.
 *
 * @param {object} context Raw Queue.addBulk invocation.
 * @returns {object} Semantic messaging facts.
 */
function startBulk (context) {
  const jobs = context.arguments[0]
  const queueName = context.self?.name
  if (!Array.isArray(jobs)) {
    return {
      action: 'addBulk',
      destination: queueName || 'bullmq',
      messages: undefined,
    }
  }

  const messages = []
  for (let index = 0; index < jobs.length; index++) {
    const job = jobs[index]
    if (!job) continue
    messages.push({
      body: job.data,
      filter: {
        data: job.data,
        name: job.name,
        opts: job.opts,
        queueName,
      },
      index,
    })
  }

  return {
    action: 'addBulk',
    destination: queueName || 'bullmq',
    filterCount: jobs.length,
    messageCount: jobs.length,
    messages,
  }
}

/**
 * Write Queue.addBulk propagation back to accepted job options.
 *
 * @param {object} context Raw Queue.addBulk invocation.
 * @param {object} facts Normalized messaging facts.
 * @param {{carriers: Array<{carrier: object, index: number}>}} updates Processor-owned carrier updates.
 * @returns {void}
 */
function updateBulk (context, facts, updates) {
  const jobs = context.arguments[0]
  for (const { carrier, index } of updates.carriers) {
    const job = jobs[index]
    job.opts ||= {}
    writeCarrier(job.opts, carrier)
  }
}

/**
 * Normalize one FlowProducer.add invocation.
 *
 * @param {object} context Raw FlowProducer.add invocation.
 * @returns {object} Semantic messaging facts.
 */
function startFlow (context) {
  const flow = context.arguments[0]
  const queueName = flow?.queueName

  return {
    action: 'add',
    destination: queueName || 'bullmq',
    filterCount: 1,
    messages: [{
      body: flow?.data,
      filter: {
        data: flow?.data,
        name: flow?.name,
        opts: flow?.opts,
        queueName,
      },
      index: 0,
      writable: Boolean(flow),
    }],
  }
}

/**
 * Write FlowProducer.add propagation back to its root job options.
 *
 * @param {object} context Raw FlowProducer.add invocation.
 * @param {object} facts Normalized messaging facts.
 * @param {{carriers: Array<{carrier: object}>}} updates Processor-owned carrier updates.
 * @returns {void}
 */
function updateFlow (context, facts, updates) {
  const flow = context.arguments[0]
  flow.opts ||= {}
  writeCarrier(flow.opts, updates.carriers[0].carrier)
}

module.exports = {
  targets: [
    {
      lifecycle: 'async',
      module: 'bullmq',
      name: 'Queue_add',
      start: startQueue,
      updateSource: updateQueue,
    },
    {
      lifecycle: 'async',
      module: 'bullmq',
      name: 'Queue_addBulk',
      start: startBulk,
      updateSource: updateBulk,
    },
    {
      lifecycle: 'async',
      module: 'bullmq',
      name: 'FlowProducer_add',
      start: startFlow,
      updateSource: updateFlow,
    },
  ],
}
module.exports.parseTelemetryMetadata = parseTelemetryMetadata
