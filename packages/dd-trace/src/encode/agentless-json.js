'use strict'

const log = require('../log')
const { TOP_LEVEL_KEY } = require('../constants')
const { truncateSpan, normalizeSpan } = require('./tags-processors')

// Soft limit for estimated payload size. Triggers an early flush to stay under intake request size limits.
const SOFT_LIMIT = 8 * 1024 * 1024 // 8MB

/**
 * Formats a span for JSON encoding.
 * @param {object} span - The span to format
 * @param {boolean} isFirstSpan - Whether this is the first span in the trace
 * @returns {object} The formatted span
 */
function formatSpan (span, isFirstSpan) {
  span = normalizeSpan(truncateSpan(span, false))

  // Remove _dd.p.tid (the upper 64 bits of a 128-bit trace ID) since trace_id is truncated to lower 64 bits
  delete span.meta['_dd.p.tid']

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
    trace_id: span.trace_id.toString(16).toLowerCase().slice(-16),
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
 * JSON encoder for agentless trace intake.
 * Encodes multiple traces as JSON with the payload format: {"traces": [{spans: [...], ...metadata}, ...]}
 *
 * Traces are accumulated until flushed (timer-based, size-based, or explicit).
 */
class AgentlessJSONEncoder {
  /**
   * @param {object} writer - Writer instance with a flush() method, called when the buffer exceeds the soft limit
   * @param {object} [metadata={}] - Shared metadata spread into each trace object (hostname, env, tracerVersion, etc.)
   */
  constructor (writer, metadata = {}) {
    this._writer = writer
    this._metadata = metadata
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
   * Encodes a trace (array of spans) and adds it to the pending batch.
   * @param {object[]} trace - Array of spans to encode
   */
  encode (trace) {
    const spanStrings = []
    let traceSize = 0

    for (const span of trace) {
      try {
        const formattedSpan = formatSpan(span, spanStrings.length === 0)
        const serialized = JSON.stringify(spanToJSON(formattedSpan))
        spanStrings.push(serialized)
        traceSize += serialized.length
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

    if (spanStrings.length > 0) {
      this._traces.push(spanStrings)
      this._traceCount++
      this._estimatedSize += traceSize
    } else if (trace.length > 0) {
      log.error('All %d span(s) in trace failed to encode. Entire trace dropped.', trace.length)
    }

    if (this._estimatedSize > SOFT_LIMIT) {
      log.debug('Buffer went over soft limit, flushing')
      try {
        this._writer.flush()
      } catch (err) {
        log.error('Failed to flush on soft limit: %s\n%s', err.message, err.stack)
      }
    }
  }

  /**
   * Creates the JSON payload for the encoded traces.
   * Builds the payload via string concatenation from pre-serialized spans to avoid double-stringify.
   * @returns {Buffer} JSON payload as a buffer, or empty buffer if no traces
   */
  makePayload () {
    if (this._traces.length === 0) {
      this._reset()
      return Buffer.alloc(0)
    }

    try {
      const metadataJson = JSON.stringify(this._metadata)
      // Strip trailing '}' so we can append ',"spans":[...]}'
      const metadataPrefix = metadataJson.slice(0, -1)
      const hasMetadata = metadataPrefix.length > 1 // more than just '{'

      const traceParts = []
      for (const spanStrings of this._traces) {
        const spansJson = '[' + spanStrings.join(',') + ']'
        if (hasMetadata) {
          traceParts.push(metadataPrefix + ',"spans":' + spansJson + '}')
        } else {
          traceParts.push('{"spans":' + spansJson + '}')
        }
      }

      const payload = '{"traces":[' + traceParts.join(',') + ']}'
      this._reset()
      return Buffer.from(payload, 'utf8')
    } catch (err) {
      log.error(
        'Failed to encode traces as JSON (%d traces). Traces will be dropped. Error: %s\n%s',
        this._traces.length,
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

  _reset () {
    this._traces = []
    this._traceCount = 0
    this._estimatedSize = 0
  }
}

module.exports = { AgentlessJSONEncoder }
