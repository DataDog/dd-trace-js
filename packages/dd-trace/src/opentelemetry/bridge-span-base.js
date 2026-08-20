'use strict'

const { isSpanFinished } = require('../opentracing/span-lifecycle')
const {
  addOtelEvent,
  addOtelLink,
  addOtelLinks,
  applyOtelStatus,
  recordException,
  setOtelAttribute,
  setOtelAttributes,
  setOtelOperationName,
  setOtelResource,
} = require('./span-helpers')
const { registerDatadogSpan } = require('./span-registry')

/**
 * Shared base for the OTel-bridge span classes (`Span` and `ActiveSpanProxy`). Subclasses
 * pass the underlying Datadog span to `super(ddSpan)` and provide `spanContext()`, `end()`,
 * and `updateName()`. The writable-span gate lives in the helpers in `span-helpers.js`,
 * so neither bridge can drift from it.
 *
 * The wrapped span is private. Cross-module adapter identity is maintained by
 * `span-registry.js` rather than by exposing a mutable backing field.
 */
class BridgeSpanBase {
  #datadogSpan
  // OTel SpanStatusCode: 0 = UNSET, 1 = OK, 2 = ERROR. Tracked for OK-is-final precedence.
  #statusCode = 0

  /**
   * @param {import('../opentracing/span')} ddSpan
   */
  constructor (ddSpan) {
    this.#datadogSpan = ddSpan
    registerDatadogSpan(this, ddSpan)
    this._otelTraceSemanticsEnabled = false
  }

  get ended () {
    return isSpanFinished(this.#datadogSpan)
  }

  isRecording () {
    return !this.ended
  }

  /**
   * @param {string} key
   * @param {import('@opentelemetry/api').AttributeValue} value
   */
  setAttribute (key, value) {
    setOtelAttribute(this.#datadogSpan, key, value, this._otelTraceSemanticsEnabled)
    return this
  }

  /**
   * @param {import('@opentelemetry/api').Attributes} attributes
   */
  setAttributes (attributes) {
    setOtelAttributes(this.#datadogSpan, attributes, this._otelTraceSemanticsEnabled)
    return this
  }

  /**
   * @param {string} name
   * @param {import('@opentelemetry/api').Attributes | import('@opentelemetry/api').TimeInput} [attributesOrStartTime]
   * @param {import('@opentelemetry/api').TimeInput} [startTime]
   */
  addEvent (name, attributesOrStartTime, startTime) {
    addOtelEvent(this.#datadogSpan, name, attributesOrStartTime, startTime)
    return this
  }

  /**
   * Accepts the OTel `Link` shape and the deprecated `(SpanContext, Attributes)` form.
   *
   * @param {import('@opentelemetry/api').Link | import('@opentelemetry/api').SpanContext} link
   * @param {import('@opentelemetry/api').Attributes} [attrs]
   */
  addLink (link, attrs) {
    addOtelLink(this.#datadogSpan, link, attrs)
    return this
  }

  /**
   * @param {import('@opentelemetry/api').Link[]} links
   */
  addLinks (links) {
    addOtelLinks(this.#datadogSpan, links)
    return this
  }

  /**
   * @param {import('@opentelemetry/api').Exception} exception
   * @param {import('@opentelemetry/api').TimeInput} [timeInput]
   */
  recordException (exception, timeInput) {
    recordException(this.#datadogSpan, exception, timeInput, this._otelTraceSemanticsEnabled)
  }

  /**
   * @param {import('@opentelemetry/api').SpanStatus} status
   */
  setStatus (status) {
    this.#statusCode = applyOtelStatus(
      this.#datadogSpan,
      this.#statusCode,
      status,
      this._otelTraceSemanticsEnabled
    )
    return this
  }

  /**
   * Apply an OTel name update to the wrapped Datadog span.
   *
   * @param {string} name
   * @param {boolean} operationName
   */
  _updateDatadogName (name, operationName) {
    if (operationName) {
      setOtelOperationName(this.#datadogSpan, name)
    } else {
      setOtelResource(this.#datadogSpan, name)
    }
  }

  /**
   * Finish the wrapped Datadog span.
   *
   * @param {number} endTime
   */
  _finishDatadogSpan (endTime) {
    this.#datadogSpan.finish(endTime)
  }

  /**
   * Invoke a callback with the wrapped Datadog span without exposing it.
   *
   * @param {(span: import('../opentracing/span')) => void} callback
   */
  _withDatadogSpan (callback) {
    callback(this.#datadogSpan)
  }
}

module.exports = BridgeSpanBase
