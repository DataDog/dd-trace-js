'use strict'

const { MAX_META_VALUE_LENGTH } = require('../encode/tags-processors')
const DatadogSpanContext = require('../opentracing/span_context')
const { isError } = require('../util')
const { getWriter } = require('./event-writer')

/**
 * @typedef {object} ErrorLike Anything `isError` accepts: a real `Error`, or any
 * object carrying a message.
 * @property {string} [message]
 * @property {string} [code]
 * @property {string} [name]
 * @property {string} [stack]
 */

const ERROR = 'error'
const ERROR_MESSAGE = 'error.message'
const ERROR_STACK = 'error.stack'
const ERROR_TYPE = 'error.type'

/**
 * Reads of the tag map, sampling state and trace state land here instead of
 * throwing. Shared, so a context costs nothing per instance for state this
 * implementation deliberately does not keep — and equally, a product that writes
 * through one of these (`context._sampling.priority = 2`) writes into a
 * process-wide object rather than its own span. That is one of the accepted
 * breakages of this PoC, not a supported path.
 */
const SHARED_EMPTY_TAGS = {}
const SHARED_EMPTY_TRACE = { started: [], finished: [], tags: {} }
const SHARED_EMPTY_SAMPLING = {}

/**
 * Four ids and nothing else: no tag map, no sampling object, no links or events
 * arrays, no stored start time. Every mutation goes straight into the shared
 * buffer through the process-wide `EventWriter`; nothing is a field kept for
 * later read-back, which is why every getter below is a no-op.
 *
 * The prototype chain is spliced onto `DatadogSpanContext` so `instanceof`
 * checks on the propagation and tracer paths still recognise this as a span
 * context.
 */
class NativeSpanContext {
  /**
   * @param {import('./id').NativeId} traceId 128-bit, in four lanes.
   * @param {import('./id').NativeId} segmentId Local trace root's span id.
   * @param {import('./id').NativeId} spanId
   * @param {import('./id').NativeId} parentId Zero for a local root.
   */
  constructor (traceId, segmentId, spanId, parentId) {
    this._traceId = traceId
    this._segmentId = segmentId
    this._spanId = spanId
    this._parentId = parentId
  }

  /**
   * @param {boolean} [get128bitId]
   * @returns {string}
   */
  toTraceId (get128bitId = false) {
    if (get128bitId) {
      return this._traceId.toString(16).padStart(32, '0')
    }
    return this._traceId.toString(10)
  }

  /**
   * @param {boolean} [get128bitId]
   * @returns {string}
   */
  toSpanId (get128bitId = false) {
    if (get128bitId) {
      return this._spanId.toString(16).padStart(16, '0')
    }
    return this._spanId.toString(10)
  }

  /**
   * @returns {bigint}
   */
  toBigIntSpanId () {
    return this._spanId.toBigInt()
  }

  /**
   * @returns {string}
   */
  toTraceparent () {
    // Sampling is a stated non-goal of this PoC: every completed span is
    // exported, so the sampled flag is always "keep".
    return `00-${this.toTraceId(true)}-${this.toSpanId(true)}-01`
  }

  /**
   * Write a tag as an event. `undefined` is dropped rather than written, matching
   * the baseline's format-time behaviour of skipping absent values; booleans
   * become `0` / `1` numbers, so there is no dedicated boolean event kind.
   *
   * @param {string} key
   * @param {unknown} value
   */
  setTag (key, value) {
    const writer = getWriter()

    switch (typeof value) {
      case 'string':
        writer.setTagString(this, key, truncate(value))
        break
      case 'number':
        if (!Number.isNaN(value)) writer.setTagNumber(this, key, value)
        break
      case 'boolean':
        writer.setTagNumber(this, key, value ? 1 : 0)
        break
      case 'undefined':
        break
      default:
        if (key === ERROR && isErrorLike(value)) {
          this.#setErrorTags(writer, value)
        } else if (value !== null) {
          writer.setTagString(this, key, truncate(String(value)))
        }
    }
  }

  /**
   * Expand `setTag('error', err)` at write time. The baseline defers this to
   * `span_format`'s `extractError`, which has no equivalent here — there is no
   * JS-side span object left for a format pass to read.
   *
   * @param {import('./event-writer').EventWriter} writer
   * @param {ErrorLike} error
   */
  #setErrorTags (writer, error) {
    const message = error.message || error.code
    if (message != null) writer.setTagString(this, ERROR_MESSAGE, truncate(String(message)))
    if (error.name != null) writer.setTagString(this, ERROR_TYPE, truncate(String(error.name)))
    if (error.stack != null) writer.setTagString(this, ERROR_STACK, truncate(String(error.stack)))
    writer.setTagNumber(this, ERROR, 1)
  }

  /** @returns {undefined} No tag map is kept, so there is never anything to read. */
  getTag () {}

  /** @returns {boolean} */
  hasTag () {
    return false
  }

  deleteTag () {}

  /** @returns {object} */
  getTags () {
    return SHARED_EMPTY_TAGS
  }

  clearTags () {}
}

// Prototype-level defaults rather than constructor assignments: reads resolve,
// and an instance pays nothing for them. `_tags` is one of them precisely because
// products reach for it directly — the point is that such a read finds an empty map
// instead of throwing.
// eslint-disable-next-line eslint-rules/eslint-no-private-tags-access
NativeSpanContext.prototype._tags = SHARED_EMPTY_TAGS
NativeSpanContext.prototype._trace = SHARED_EMPTY_TRACE
NativeSpanContext.prototype._sampling = SHARED_EMPTY_SAMPLING
NativeSpanContext.prototype._baggageItems = SHARED_EMPTY_TAGS
NativeSpanContext.prototype._links = []
NativeSpanContext.prototype._isRemote = false
NativeSpanContext.prototype._isFinished = false
NativeSpanContext.prototype._name = undefined
NativeSpanContext.prototype._tracestate = undefined
NativeSpanContext.prototype._traceparent = undefined
NativeSpanContext.prototype._spanSampling = undefined
NativeSpanContext.prototype._hostname = undefined
NativeSpanContext.prototype._noop = null

Object.setPrototypeOf(NativeSpanContext.prototype, DatadogSpanContext.prototype)

/**
 * Carries `isError`'s decision into the type system, so `#setErrorTags` can take a
 * typed parameter instead of an `unknown` cast in the middle of `setTag`.
 *
 * @param {unknown} value
 * @returns {value is ErrorLike}
 */
function isErrorLike (value) {
  return isError(value)
}

/**
 * @param {string} value
 * @returns {string}
 */
function truncate (value) {
  return value.length > MAX_META_VALUE_LENGTH
    ? `${value.slice(0, MAX_META_VALUE_LENGTH)}...`
    : value
}

module.exports = NativeSpanContext
