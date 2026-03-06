'use strict'

const log = require('../log')
const { truncateSpan, normalizeSpan } = require('./tags-processors')

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
 * Converts a span to JSON-serializable format.
 * IDs are converted to lowercase hex strings. Start time is converted from
 * nanoseconds to seconds for the intake format.
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
 * Encodes a single trace as JSON with the payload format: {"spans": [...]}
 *
 * This encoder handles one trace at a time since each trace must be sent as a
 * separate request to the intake. -- bengl
 */
class AgentlessJSONEncoder {
  constructor () {
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
  }

  /**
   * Creates the JSON payload for the encoded trace.
   * @returns {Buffer} JSON payload as a buffer, or empty buffer if no spans
   */
  makePayload () {
    if (this._spans.length === 0) {
      this._reset()
      return Buffer.alloc(0)
    }

    try {
      const payload = JSON.stringify({ spans: this._spans })
      this._reset()
      return Buffer.from(payload, 'utf8')
    } catch (err) {
      log.error(
        'Failed to encode trace as JSON (%d spans). Trace will be dropped. Error: %s',
        this._spans.length,
        err.message
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

  _reset () {
    this._spans = []
    this._spanCount = 0
  }
}

module.exports = { AgentlessJSONEncoder }
