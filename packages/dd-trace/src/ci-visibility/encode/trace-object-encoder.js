'use strict'

/**
 * @param {number} value
 */
function normalizeNumber (value) {
  return Number.isFinite(value) ? value || 0 : null
}

/**
 * @param {import('../../span_format').FormattedSpan['metrics']} metrics
 */
function normalizeMetrics (metrics) {
  let result = metrics
  for (const key of Object.keys(metrics)) {
    const value = metrics[key]
    if (typeof value !== 'number') continue

    const normalized = normalizeNumber(value)
    if (Object.is(value, normalized)) continue

    if (result === metrics) result = { ...metrics }
    // The intake encoder skipped these entries when JSON turned them into null.
    if (normalized === null) {
      delete result[key]
    } else {
      result[key] = normalized
    }
  }
  return result
}

/**
 * @param {import('../../span_format').FormattedSpan} span
 */
function encodeSpan (span) {
  return {
    trace_id: span.trace_id.toString(),
    span_id: span.span_id.toString(),
    parent_id: span.parent_id.toString(),
    name: span.name,
    resource: span.resource,
    service: span.service,
    type: span.type,
    error: span.error,
    meta: span.meta,
    metrics: normalizeMetrics(span.metrics),
    start: normalizeNumber(span.start),
    duration: normalizeNumber(span.duration),
  }
}

/**
 * Projects a trace to plain objects and estimates its size for IPC batching.
 * @param {boolean} includeAgentFields - Whether the parent may send spans to the APM trace intake.
 * @param {import('../../span_format').FormattedSpan[]} trace
 */
function encodeTrace (includeAgentFields, trace) {
  const payload = []
  let bytes = 3 // Trace brackets and a batch separator.
  for (const span of trace) {
    const encoded = encodeSpan(span)
    // Allow for fixed keys, IDs, numbers, and separators. Count UTF-8 text without building another serialized trace.
    bytes += 320 + Buffer.byteLength(span.name) + Buffer.byteLength(span.resource) +
      Buffer.byteLength(span.service ?? '') + Buffer.byteLength(span.type ?? '')
    for (const key of Object.keys(encoded.meta)) {
      bytes += Buffer.byteLength(key) + Buffer.byteLength(encoded.meta[key]) + 6
    }
    for (const key of Object.keys(encoded.metrics)) {
      const value = encoded.metrics[key]
      bytes += Buffer.byteLength(key) + (typeof value === 'string' ? Buffer.byteLength(value) : 24) + 6
    }

    const { meta_struct: metaStruct, span_events: spanEvents } = span
    if (includeAgentFields && (metaStruct !== undefined || spanEvents !== undefined)) {
      // The APM fallback can export these fields. Preserve their JSON value conversions.
      const agentFields = JSON.stringify({ meta_struct: metaStruct, span_events: spanEvents })
      Object.assign(encoded, JSON.parse(agentFields))
      bytes += Buffer.byteLength(agentFields)
    }
    payload.push(encoded)
  }
  return { payload, bytes }
}

module.exports = encodeTrace
