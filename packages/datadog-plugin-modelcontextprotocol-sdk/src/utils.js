'use strict'

const { ERROR_MESSAGE, ERROR_TYPE } = require('../../dd-trace/src/constants')

const DISTRIBUTED_TRACE_META_KEY = '_dd_trace_context'
const MAX_TRACE_CONTEXT_BYTES = 4096
const TRACE_CONTEXT_FIELDS = [
  ['x-datadog-trace-id', 32],
  ['x-datadog-parent-id', 32],
  ['x-datadog-origin', 256],
  ['x-datadog-sampling-priority', 32],
  ['x-datadog-tags', 512],
  ['x-b3-traceid', 32],
  ['x-b3-spanid', 16],
  ['x-b3-parentspanid', 16],
  ['x-b3-sampled', 1],
  ['x-b3-flags', 1],
  ['b3', 80],
  ['traceparent', 256],
  ['tracestate', 512],
  ['baggage', 2048],
]

/**
 * Returns a bounded text-map carrier from MCP request metadata.
 *
 * @param {unknown} traceContext MCP client-provided distributed trace metadata.
 * @returns {Record<string, string> | undefined} A safe propagation carrier.
 */
function getTraceContextCarrier (traceContext) {
  if (!traceContext || typeof traceContext !== 'object' || Array.isArray(traceContext)) return

  const carrier = {}
  let byteCount = 0
  let hasTraceContext = false

  for (const [key, maxLength] of TRACE_CONTEXT_FIELDS) {
    const value = traceContext[key]
    if (value === undefined) continue
    if (typeof value !== 'string' || value.length > maxLength) return

    byteCount += value.length
    if (byteCount > MAX_TRACE_CONTEXT_BYTES) return

    carrier[key] = value
    hasTraceContext = true
  }

  return hasTraceContext ? carrier : undefined
}

function getFirstTextContent (content) {
  if (!Array.isArray(content)) return

  for (const item of content) {
    if (item.type === 'text' && item.text) return item.text
  }
}

function setErrorTags (span, message) {
  span.setTag('error', 1)
  span.setTag(ERROR_TYPE, 'Error')
  span.setTag(ERROR_MESSAGE, message)
}

function tagErrorResult (span, result) {
  if (result?.isError) {
    setErrorTags(span, getFirstTextContent(result.content) || 'Tool call returned isError: true')
  }
}

module.exports = {
  DISTRIBUTED_TRACE_META_KEY,
  getTraceContextCarrier,
  tagErrorResult,
}
