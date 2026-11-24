'use strict'

const crypto = require('node:crypto')
const dgram = require('node:dgram')

const { getEnvironmentVariable } = require('../../dd-trace/src/config/helper')
const log = require('../../dd-trace/src/log')
const { getAWSTraceHeader, parseAWSTraceHeader } = require('./context/xray')

/** @param {Record<string, unknown>} metadata Extracted Datadog trace context. */
function addMetadata (metadata) {
  add('trace', metadata)
}

/** @param {import('./context/step-functions').StepFunctionContext} context Source Step Functions context. */
function addStepFunctionContext (context) {
  add('root_span_metadata', context)
}

/** @param {Record<string, string|undefined>} tags Completed invocation's trigger tags. */
function addLambdaTriggerTags (tags) {
  add('lambda_function_tags', tags)
}

/**
 * Emit the shim's X-Ray metadata protocol without adding a tracer span or an invocation flush barrier.
 * @param {string} key Source metadata key.
 * @param {Record<string, unknown>} metadata Source metadata payload.
 */
function add (key, metadata) {
  try {
    const header = getAWSTraceHeader()
    const context = header === undefined ? undefined : parseAWSTraceHeader(header)
    if (!context || parseInt(context.sampled, 10) !== 1) return

    const time = Date.now() * 0.001
    const segment = JSON.stringify({
      id: crypto.randomBytes(8).toString('hex'),
      trace_id: context.traceId,
      parent_id: context.parentId,
      name: 'datadog-metadata',
      start_time: time,
      end_time: time,
      type: 'subsegment',
      metadata: { datadog: { [key]: metadata } },
    })
    // eslint-disable-next-line eslint-rules/eslint-non-prefix-env-names -- Per-invocation daemon, not cached config.
    const daemon = getEnvironmentVariable('AWS_XRAY_DAEMON_ADDRESS')
    if (daemon === undefined) return
    const parts = daemon.split(':')
    if (parts.length <= 1) return

    // Preserve the source's host:first-port parsing, including additional colon-separated fields.
    const message = Buffer.from(`{"format": "json", "version": 1}\n${segment}`)
    const socket = dgram.createSocket('udp4')
    let closed = false
    const complete = error => {
      if (closed) return
      closed = true
      socket.removeListener('error', complete)
      try {
        socket.close()
      } catch (error) {
        log.debug('Unable to close Lambda X-Ray socket: %s', error)
      }
      if (error) log.debug('Unable to send Lambda X-Ray metadata: %s', error)
    }
    // Socket error events can precede the send callback; telemetry must not terminate the application.
    socket.once('error', complete)
    try {
      socket.send(message, 0, message.length, parseInt(parts[1], 10), parts[0], complete)
    } catch (error) {
      complete(error)
    }
  } catch (error) {
    log.debug('Unable to submit Lambda X-Ray metadata: %s', error)
  }
}

module.exports = { addMetadata, addStepFunctionContext, addLambdaTriggerTags }
