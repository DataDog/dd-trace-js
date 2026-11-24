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
 * @param {boolean} includeAgentFields - Whether the parent may send spans to the APM trace intake.
 */
function encodeSpan (span, includeAgentFields) {
  const payload = {
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
  const { meta_struct: metaStruct, span_events: spanEvents } = span
  if (includeAgentFields && (metaStruct !== undefined || spanEvents !== undefined)) {
    // The APM fallback can export these fields. Preserve their JSON value conversions.
    // eslint-disable-next-line unicorn/prefer-structured-clone
    Object.assign(payload, JSON.parse(JSON.stringify({ meta_struct: metaStruct, span_events: spanEvents })))
  }
  return payload
}

/** Buffers traces and projects them to plain objects for the worker's IPC transport. */
class TraceObjectEncoder {
  #traces = []
  #includeAgentFields

  /**
   * @param {boolean} includeAgentFields
   */
  constructor (includeAgentFields) {
    this.#includeAgentFields = includeAgentFields
  }

  /**
   * @param {import('../../span_format').FormattedSpan[]} trace
   */
  encode (trace) {
    this.#traces.push(trace)
  }

  count () {
    return this.#traces.length
  }

  makePayload () {
    const traces = this.#traces
    this.#traces = []
    return traces.map(trace => trace.map(span => encodeSpan(span, this.#includeAgentFields)))
  }
}

module.exports = TraceObjectEncoder
