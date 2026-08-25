'use strict'

const log = require('../../dd-trace/src/log')

/**
 * Remove and return Datadog propagation fields from BullMQ telemetry metadata.
 *
 * @param {object | undefined} job BullMQ job.
 * @returns {object | undefined} Extracted Datadog carrier.
 */
function extractDatadog (job) {
  const metadataString = job?.opts?.telemetry?.metadata
  if (!metadataString) return

  try {
    const metadata = JSON.parse(metadataString)
    const carrier = metadata._datadog
    if (!carrier) return

    metadata._datadog = undefined
    job.opts.telemetry.metadata = JSON.stringify(metadata)
    return carrier
  } catch (error) {
    log.warn('bullmq: skipping _datadog extract on malformed telemetry.metadata: %s', error.message)
  }
}

/**
 * Normalize one Worker.callProcessJob invocation.
 *
 * @param {object} context Raw Worker.callProcessJob invocation.
 * @returns {object} Semantic messaging facts.
 */
function startConsumer (context) {
  const job = context.arguments[0]

  return {
    action: 'processJob',
    body: job?.data,
    carrier: extractDatadog(job),
    destination: job?.queueName || job?.queue?.name || 'bullmq',
  }
}

module.exports = {
  targets: [{
    lifecycle: 'async',
    module: 'bullmq',
    name: 'Worker_callProcessJob',
    start: startConsumer,
  }],
}
module.exports.extractDatadog = extractDatadog
