'use strict'

const { getMessageSize } = require('../../dd-trace/src/datastreams')
const log = require('../../dd-trace/src/log')
const { argument, field } = require('../../dd-trace/src/plugins/orchestrion-pipeline')

/**
 * Remove and return Datadog propagation fields from BullMQ telemetry metadata.
 *
 * @param {object | undefined} job
 * @returns {object | undefined}
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
 * Resolve the messaging consumer service using the existing naming schema.
 *
 * @param {import('../../dd-trace/src/plugins/orchestrion-pipeline').PipelineFrame} frame
 * @returns {string | {name: string, source?: string}}
 */
function consumerService (frame) {
  return frame.config.service || frame.plugin.serviceName({ type: 'messaging', kind: 'consumer' })
}

const consumerDsmStage = {
  name: 'data-streams',
  start (frame) {
    if (!frame.config.dsmEnabled) return

    const job = frame.data.job
    if (!job) return
    const carrier = frame.data.carrier
    if (carrier) frame.tracer.decodeDataStreamsContext(carrier)
    frame.tracer.setCheckpoint(
      ['direction:in', `topic:${frame.data.queueName}`, 'type:bullmq'],
      frame.span,
      job.data ? getMessageSize(job.data) : 0
    )
  },
}

const operation = {
  target: { module: 'bullmq', name: 'Worker_callProcessJob' },
  lifecycle: 'async',
  extract: {
    start: {
      job: argument(0),
      queueName: context => context.arguments[0]?.queueName || context.arguments[0]?.queue?.name || 'bullmq',
      carrier: context => extractDatadog(context.arguments[0]),
    },
  },
  span: {
    name: 'bullmq.processJob',
    service: consumerService,
    resource: field('queueName'),
    type: 'messaging',
    kind: 'consumer',
    childOf: frame => frame.data.carrier && frame.tracer.extract('text_map', frame.data.carrier),
    tags: {
      component: 'bullmq',
      'span.kind': 'consumer',
      'messaging.system': 'bullmq',
      'messaging.destination.name': field('queueName'),
      'messaging.operation': 'process',
    },
  },
  stages: [consumerDsmStage],
}

module.exports = operation
module.exports.extractDatadog = extractDatadog
