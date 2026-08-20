'use strict'

const util = require('util')
const { AUTO_KEEP } = require('../../../../ext/priority')
const eventWriter = require('./event-writer')

// the lowercase, hex encoded upper 64 bits of a 128-bit trace id, if present
const TRACE_ID_128 = '_dd.p.tid'

class DatadogSpanContext {
  constructor (props) {
    eventWriter.initializeContext(this, props)
  }

  [util.inspect.custom] () {
    return {
      ...this,
      _trace: {
        ...this._trace,
        started: '[Array]',
        finished: '[Array]',
      },
    }
  }

  toTraceId (get128bitId = false) {
    if (get128bitId) {
      return this._traceId.toTraceIdHex(this._trace.tags[TRACE_ID_128]).padStart(32, '0')
    }
    return this._traceId.toString(10)
  }

  toSpanId (get128bitId = false) {
    if (get128bitId) {
      return this._spanId.toString(16).padStart(16, '0')
    }
    return this._spanId.toString(10)
  }

  toBigIntSpanId () {
    return this._spanId.toBigInt()
  }

  /**
   * Return the trace identifier used by deterministic samplers.
   *
   * @returns {bigint}
   */
  toBigIntTraceId () {
    return this._traceId.toBigInt()
  }

  /**
   * Return W3C trace flags after materializing lazy priority sampling.
   *
   * @returns {number}
   */
  toTraceFlags () {
    this._ensureSamplingPriority()
    return this._sampling.priority >= AUTO_KEEP ? 1 : 0
  }

  /**
   * Serialize W3C tracestate from the propagation envelope.
   *
   * @returns {string}
   */
  toTracestate () {
    return this._tracestate?.toString() || ''
  }

  toTraceparent () {
    const flags = this.toTraceFlags() ? '01' : '00'
    const traceId = this.toTraceId(true)
    const spanId = this.toSpanId(true)
    const version = (this._traceparent && this._traceparent.version) || '00'
    return `${version}-${traceId}-${spanId}-${flags}`
  }

  /**
   * Materialize the lazy priority-sampling decision for this trace, the same
   * way {@link DatadogTracer#inject} does before propagation. The auto priority
   * is otherwise computed at flush time, so the W3C sampled flag reads "drop"
   * for a freshly started, not-yet-flushed span — see
   * https://github.com/DataDog/dd-trace-js/issues/2547.
   *
   * The root span is only used to reach the priority sampler; `this` is passed
   * to `sample()` so a manual sampling tag set directly on this context is
   * honored, matching what `inject(this)` would decide.
   */
  _ensureSamplingPriority () {
    if (this._sampling.priority !== undefined) return
    this._trace.started[0]?._prioritySampler?.sample(this)
  }

  /**
   * Set a tag value.
   * @param {string} key - Tag key
   * @param {unknown} value - Tag value
   */
  setTag (key, value) {
    eventWriter.setTag(this, key, value)
  }

  /**
   * Get a tag value.
   * @param {string} key - Tag key
   * @returns {unknown} Tag value or undefined
   */
  getTag (key) {
    return this._tags[key]
  }

  /**
   * Check if a tag exists.
   * @param {string} key - Tag key
   * @returns {boolean}
   */
  hasTag (key) { return Object.hasOwn(this._tags, key) }

  /**
   * Delete a tag.
   * @param {string} key - Tag key
   */
  deleteTag (key) { eventWriter.deleteTag(this, key) }

  /**
   * Get the live internal tags map. The returned reference is mutable;
   * callers may assign or delete keys directly (e.g.
   * `Object.assign(getTags(), tags)` in span.js). Subclasses may have
   * additional sync side effects on the individual `setTag` / `deleteTag`
   * setters; mutating the returned map bypasses those.
   *
   * @returns {object}
   */
  getTags () {
    return this._tags
  }

  /**
   * Clear all tags.
   */
  clearTags () { eventWriter.clearTags(this) }
}

module.exports = DatadogSpanContext
