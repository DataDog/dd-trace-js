'use strict'

const { createHash } = require('node:crypto')

const { readStepFunctionTraceContext } = require('../../../dd-trace/src/carrier')
const id = require('../../../dd-trace/src/id')
const { fromTraceContext, AUTO_KEEP } = require('./span-context')

/**
 * @typedef {object} StepFunctionContext
 * @property {string} execution_id
 * @property {string} redrive_count
 * @property {string} retry_count
 * @property {string} state_entered_time
 * @property {string} state_name
 * @property {string} [root_execution_id]
 * @property {string} [serverless_version]
 * @property {string} [trace_id]
 * @property {string} [dd_p_tid]
 */

/** @param {Record<string, unknown>} context Step Functions payload. */
function isValidContext (context) {
  return typeof context?.Execution?.Id === 'string' &&
    typeof context?.State?.EnteredTime === 'string' && typeof context?.State?.Name === 'string'
}

// Preserve source envelope handling, including its null/object semantics.
/* eslint-disable eslint-rules/eslint-safe-typeof-object */
/**
 * @param {Record<string, unknown>} event Lambda event or message carrier.
 * @returns {StepFunctionContext|undefined}
 */
function getStepFunctionContext (event) {
  if (typeof event !== 'object') return
  if (typeof event?.Payload?._datadog === 'object' || isValidContext(event?.Payload)) event = event.Payload
  if (typeof event._datadog === 'object') event = event._datadog
  if (!isValidContext(event)) return

  const context = {
    execution_id: event.Execution.Id,
    redrive_count: (event.Execution.RedriveCount ?? '0').toString(),
    retry_count: (event.State.RetryCount ?? '0').toString(),
    state_entered_time: event.State.EnteredTime,
    state_name: event.State.Name,
  }
  if (event['serverless-version'] === 'v1') {
    if (typeof event.RootExecutionId === 'string') {
      return { ...context, root_execution_id: event.RootExecutionId, serverless_version: 'v1' }
    }
    const trace = readStepFunctionTraceContext(event)
    if (trace) {
      return {
        ...context,
        trace_id: trace.traceId,
        dd_p_tid: parseTraceIdHigh(trace.tags),
        serverless_version: 'v1',
      }
    }
    return
  }

  const headers = event.Execution?.Input?._datadog
  const trace = typeof headers === 'object' && headers !== null && readStepFunctionTraceContext(headers)
  if (trace) {
    return {
      ...context,
      trace_id: trace.traceId,
      dd_p_tid: parseTraceIdHigh(trace.tags),
      serverless_version: 'legacy-lambda-root',
    }
  }
  return context
}
/* eslint-enable eslint-rules/eslint-safe-typeof-object */

/** @param {string} tags Datadog propagation tags. */
function parseTraceIdHigh (tags) {
  for (const tag of tags.split(',')) {
    if (tag.includes('_dd.p.tid=')) return tag.split('=')[1]
  }
  return ''
}

/**
 * Uses the same SHA-256 bytes, sign-bit masking and zero fallback as the shim.
 * @param {string} value Value to hash.
 * @param {number} offset Byte offset of the 64-bit identifier.
 */
function hashId (value, offset) {
  const hash = createHash('sha256').update(value).digest()
  return ((hash.readBigUInt64BE(offset) & 0x7F_FF_FF_FF_FF_FF_FF_FFn) || 1n).toString(10)
}

/**
 * @param {StepFunctionContext|undefined} context Parsed Step Functions context.
 * @returns {import('../../../dd-trace/src/opentracing/span_context')|null}
 */
function extractStepFunctionContext (context) {
  if (!context) return null
  let traceId
  let high
  if (typeof context.root_execution_id === 'string' && typeof context.serverless_version === 'string') {
    traceId = hashId(context.root_execution_id, 8)
    high = hashId(context.root_execution_id, 0)
  } else if (typeof context.trace_id === 'string' && typeof context.dd_p_tid === 'string' &&
      typeof context.serverless_version === 'string') {
    traceId = context.trace_id
    high = context.dd_p_tid
  } else if (context.serverless_version === undefined) {
    traceId = hashId(context.execution_id, 8)
    high = hashId(context.execution_id, 0)
  } else {
    return null
  }
  const counts = context.retry_count === '0' && context.redrive_count === '0'
    ? ''
    : `#${context.retry_count}#${context.redrive_count}`
  const parentId = hashId(`${context.execution_id}#${context.state_name}#${context.state_entered_time}${counts}`, 0)
  const spanContext = fromTraceContext({ traceId, parentId, sampleMode: AUTO_KEEP, source: 'event' })
  // Preserve the source's radix, including for Lambda-root propagated tags.
  spanContext._trace.tags['_dd.p.tid'] = id(high, 10).toString(16)
  return spanContext
}

module.exports = { getStepFunctionContext, extractStepFunctionContext }
