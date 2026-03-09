'use strict'

const log = require('../log')
const { TOP_LEVEL_KEY } = require('../constants')
const { truncateSpan, normalizeSpan } = require('./tags-processors')

const MAX_PAYLOAD_SIZE = 15 * 1024 * 1024 // 15MB - intake hard limit

/**
 * Formats a span for JSON encoding.
 * @param {object} span - The span to format
 * @param {boolean} isFirstSpan - Whether this is the first span in the trace
 * @returns {object} The formatted span
 */
function formatSpan (span, isFirstSpan) {
  span = normalizeSpan(truncateSpan(span, false))

  if (span.span_events) {
    span.meta.events = JSON.stringify(span.span_events)
    delete span.span_events
  }

  if (isFirstSpan) {
    span.meta['_dd.compute_stats'] = '1'
  }

  if (span.parent_id?.toString(10) === '0') {
    span.metrics._trace_root = 1
  }

  if (span.metrics[TOP_LEVEL_KEY]) {
    span.metrics._top_level = 1
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
 * Estimates the JSON byte size of a trace array.
 * Uses JSON.stringify since the objects are already JSON-ready.
 * @param {object[]} spans - Array of JSON-serializable span objects
 * @returns {number} Estimated byte size
 */
function estimateJsonSize (spans) {
  try {
    return JSON.stringify(spans).length
  } catch {
    return 0
  }
}

/**
 * JSON encoder for agentless span intake.
 * Buffers multiple traces and produces a single payload in the
 * {"traces": [[...], ...]} format for the intake.
 */
class AgentlessJSONEncoder {
  constructor () {
    this._reset()
  }

  /**
   * Returns the number of traces encoded.
   * @returns {number}
   */
  count () {
    return this._traceCount
  }

  /**
   * Returns whether the buffer has exceeded the maximum payload size.
   * @returns {boolean}
   */
  isFull () {
    return this._byteSize > MAX_PAYLOAD_SIZE
  }

  /**
   * Encodes a trace (array of spans) into the buffer.
   * @param {object[]} trace - Array of spans to encode
   */
  encode (trace) {
    const spans = []
    let isFirstSpan = true

    for (const span of trace) {
      try {
        const formattedSpan = formatSpan(span, isFirstSpan)
        const jsonSpan = spanToJSON(formattedSpan)

        spans.push(jsonSpan)
        isFirstSpan = false
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

    if (spans.length > 0) {
      this._traces.push(spans)
      this._traceCount++
      this._byteSize += estimateJsonSize(spans)
    }
  }

  /**
   * Creates the JSON payload for all buffered traces.
   * @returns {Buffer} JSON payload as a buffer, or empty buffer if no traces
   */
  makePayload () {
    if (this._traces.length === 0) {
      this._reset()
      return Buffer.alloc(0)
    }

    try {
      const payload = JSON.stringify({ traces: this._traces })
      this._reset()
      return Buffer.from(payload, 'utf8')
    } catch (err) {
      log.error(
        'Failed to encode traces as JSON (%d traces). Traces will be dropped. Error: %s',
        this._traces.length,
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
    this._traces = []
    this._traceCount = 0
    this._byteSize = 0
  }
}

module.exports = { AgentlessJSONEncoder }
