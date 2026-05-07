'use strict'

const BridgeSpanBase = require('./bridge-span-base')
const { setOtelResource } = require('./span-helpers')

/**
 * OTel `Span`-compatible proxy around an already-active Datadog span.
 *
 * Makes `trace.getActiveSpan()` forward attribute/link/event/status/exception writes onto
 * the Datadog span. `end()` is intentionally a no-op: the span's lifecycle belongs to
 * whoever created it. Mutation methods all bail out once the underlying Datadog span has
 * finished (gated inside the helpers), matching OTel `Span` semantics.
 */
class ActiveSpanProxy extends BridgeSpanBase {
  /** @type {import('./span_context')} */
  #otelSpanContext

  /**
   * @param {import('../opentracing/span')} ddSpan
   * @param {import('./span_context')} otelSpanContext
   */
  constructor (ddSpan, otelSpanContext) {
    super(ddSpan)
    this.#otelSpanContext = otelSpanContext
  }

  spanContext () {
    return this.#otelSpanContext
  }

  /**
   * @param {string} name
   */
  updateName (name) {
    setOtelResource(this._ddSpan, name)
    return this
  }

  end () {}
}

module.exports = ActiveSpanProxy
