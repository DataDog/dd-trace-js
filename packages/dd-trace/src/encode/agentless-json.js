'use strict'

const log = require('../log')
const { truncateSpan, normalizeSpan } = require('./tags-processors')

const SOFT_LIMIT = 8 * 1024 * 1024 // 8MB

/**
 * Formats a span for JSON encoding.
 * @param {object} span - The span to format
 * @returns {object} The formatted span
 */
function formatSpan (span) {
  span = normalizeSpan(truncateSpan(span, false))

  if (span.span_events) {
    span.meta.events = JSON.stringify(span.span_events)
    delete span.span_events
  }

  return span
}

/**
 * Converts a span to JSON-serializable format with IDs as lowercase hex strings.
 * @param {object} span - The formatted span
 * @returns {object} JSON-serializable span object
 */
function spanToJSON (span) {
  const result = {
    trace_id: span.trace_id.toString(16).toLowerCase(),
    span_id: span.span_id.toString(16).toLowerCase(),
    parent_id: span.parent_id.toString(16).toLowerCase(),
    name: span.name,
    resource: span.resource,
    service: span.service,
    error: span.error,
    start: Math.floor(span.start / 1e9),
    duration: span.duration,
    meta: span.meta,
    metrics: span.metrics,
  }

  if (span.type) {
    result.type = span.type
  }

  if (span.meta_struct) {
    result.meta_struct = span.meta_struct
  }

  if (span.links && span.links.length > 0) {
    result.links = span.links
  }

  return result
}

/**
 * JSON encoder for agentless span intake.
 * Encodes spans as JSON with the payload format: {"spans": [...]}
 */
class AgentlessJSONEncoder {
  /**
   * @param {object} writer - The writer instance
   * @param {number} [limit] - Soft limit for payload size
   */
  constructor (writer, limit = SOFT_LIMIT) {
    this._limit = limit
    this._writer = writer
    this._reset()
  }

  /**
   * Returns the number of spans encoded.
   * @returns {number}
   */
  count () {
    return this._spanCount
  }

  /**
   * Encodes a trace (array of spans) into the buffer.
   * @param {object[]} trace - Array of spans to encode
   */
  encode (trace) {
    for (const span of trace) {
      try {
        const formattedSpan = formatSpan(span)
        const jsonSpan = spanToJSON(formattedSpan)

        this._spans.push(jsonSpan)
        this._spanCount++
      } catch (err) {
        log.error(
          'Failed to encode span (name: %s, service: %s). Span will be dropped. Error: %s\n%s',
          span?.name || 'unknown',
          span?.service || 'unknown',
          err.message,
          err.stack
        )
      }
    }

    const estimatedSize = this._estimateSize()
    if (estimatedSize > this._limit) {
      log.debug('Buffer went over soft limit, flushing')
      this._writer.flush()
    }
  }

  /**
   * Creates the final JSON payloads - one per trace.
   *
   * IMPORTANT: The intake only accepts one trace per request. Multiple spans are allowed
   * but they must all share the same trace_id. Requests containing spans with different
   * trace_ids return HTTP 200 but silently drop all spans. This was confirmed through
   * extensive testing - same trace_id batches work, mixed trace_id batches are dropped.
   * We group spans by trace_id and send each trace as a separate request. -- bengl
   *
   * @returns {Buffer[]} Array of JSON payloads as buffers (one trace each)
   */
  makePayload () {
    const payloads = []

    // Group spans by trace_id
    const traceMap = new Map()
    for (const span of this._spans) {
      const traceId = span.trace_id
      if (!traceMap.has(traceId)) {
        traceMap.set(traceId, [])
      }
      traceMap.get(traceId).push(span)
    }

    // Create one payload per trace
    for (const [traceId, spans] of traceMap) {
      try {
        const payload = JSON.stringify({ spans })
        payloads.push(Buffer.from(payload, 'utf8'))
      } catch (err) {
        log.error(
          'Failed to encode trace as JSON (trace_id: %s, spans: %d). Trace will be dropped. Error: %s',
          traceId,
          spans.length,
          err.message
        )
      }
    }

    this._reset()
    return payloads
  }

  /**
   * Resets the encoder state.
   */
  reset () {
    this._reset()
  }

  /**
   * Internal reset method.
   */
  _reset () {
    this._spans = []
    this._spanCount = 0
  }

  /**
   * Estimates the current payload size.
   * @returns {number} Estimated size in bytes
   */
  _estimateSize () {
    // Rough estimate: JSON overhead + average span size
    // This is an approximation to avoid serializing on every encode
    return this._spans.length * 500 + 20
  }
}

module.exports = { AgentlessJSONEncoder }
