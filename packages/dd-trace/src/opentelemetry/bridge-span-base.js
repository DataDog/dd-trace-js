'use strict'

const { markUserVisible } = require('../user_visibility')
const {
  addOtelEvent,
  addOtelLink,
  addOtelLinks,
  applyOtelStatus,
  recordException,
  setOtelAttribute,
  setOtelAttributes,
} = require('./span-helpers')

/**
 * Shared base for the OTel-bridge span classes (`Span` and `ActiveSpanProxy`). Subclasses
 * pass the underlying Datadog span to `super(ddSpan)` and provide `spanContext()`, `end()`,
 * and `updateName()`. The writable-span gate lives in the helpers in `span-helpers.js`,
 * so neither bridge can drift from it.
 *
 * `_ddSpan` is left as a `_underscore` field rather than `#private` so the bridge does not
 * expand its published API to expose the underlying DD span. External callers that need
 * the reference (`ContextManager` proxy-cache check, OTLP serialization, tests) reach in
 * via `_ddSpan`, matching the existing convention for "internal, may break".
 */
class BridgeSpanBase {
  // OTel SpanStatusCode: 0 = UNSET, 1 = OK, 2 = ERROR. Tracked for OK-is-final precedence.
  #statusCode = 0

  /**
   * @param {import('../opentracing/span')} ddSpan
   */
  constructor (ddSpan) {
    this._ddSpan = markUserVisible(ddSpan)
  }

  get ended () {
    return this._ddSpan._duration !== undefined
  }

  isRecording () {
    return !this.ended
  }

  /**
   * @param {string} key
   * @param {import('@opentelemetry/api').AttributeValue} value
   */
  setAttribute (key, value) {
    setOtelAttribute(this._ddSpan, key, value)
    return this
  }

  /**
   * @param {import('@opentelemetry/api').Attributes} attributes
   */
  setAttributes (attributes) {
    setOtelAttributes(this._ddSpan, attributes)
    return this
  }

  /**
   * @param {string} name
   * @param {import('@opentelemetry/api').Attributes | import('@opentelemetry/api').TimeInput} [attributesOrStartTime]
   * @param {import('@opentelemetry/api').TimeInput} [startTime]
   */
  addEvent (name, attributesOrStartTime, startTime) {
    addOtelEvent(this._ddSpan, name, attributesOrStartTime, startTime)
    return this
  }

  /**
   * Accepts the OTel `Link` shape and the deprecated `(SpanContext, Attributes)` form.
   *
   * @param {import('@opentelemetry/api').Link | import('@opentelemetry/api').SpanContext} link
   * @param {import('@opentelemetry/api').Attributes} [attrs]
   */
  addLink (link, attrs) {
    addOtelLink(this._ddSpan, link, attrs)
    return this
  }

  /**
   * @param {import('@opentelemetry/api').Link[]} links
   */
  addLinks (links) {
    addOtelLinks(this._ddSpan, links)
    return this
  }

  /**
   * @param {import('@opentelemetry/api').Exception} exception
   * @param {import('@opentelemetry/api').TimeInput} [timeInput]
   */
  recordException (exception, timeInput) {
    recordException(this._ddSpan, exception, timeInput)
  }

  /**
   * @param {import('@opentelemetry/api').SpanStatus} status
   */
  setStatus (status) {
    this.#statusCode = applyOtelStatus(this._ddSpan, this.#statusCode, status)
    return this
  }
}

module.exports = BridgeSpanBase
