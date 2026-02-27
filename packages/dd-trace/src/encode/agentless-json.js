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

  // Convert span events to JSON-compatible format if present
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
    start: span.start,
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

    // Check if we've exceeded the soft limit
    const estimatedSize = this._estimateSize()
    if (estimatedSize > this._limit) {
      log.debug('Buffer went over soft limit, flushing')
      this._writer.flush()
    }
  }

  /**
   * Creates the final JSON payload.
   * @returns {Buffer} The JSON payload as a buffer (empty buffer on encoding failure)
   */
  makePayload () {
    const spanCount = this._spanCount

    try {
      const payload = JSON.stringify({ spans: this._spans })
      const buffer = Buffer.from(payload, 'utf8')

      this._reset()

      return buffer
    } catch (err) {
      log.error(
        'Failed to encode %d spans as JSON. Spans will be dropped. Error: %s\n%s',
        spanCount,
        err.message,
        err.stack
      )
      this._reset()
      return Buffer.alloc(0)
    }
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
