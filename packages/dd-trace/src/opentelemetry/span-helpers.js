'use strict'

const { ERROR_MESSAGE, ERROR_STACK, ERROR_TYPE, IGNORE_OTEL_ERROR } = require('../constants')
const DatadogSpanContext = require('../opentracing/span_context')
const TraceState = require('../opentracing/propagation/tracestate')

const id = require('../id')

/**
 * @typedef {{ toTraceId: (get128?: boolean) => string, toSpanId: (get128?: boolean) => string }} DatadogContextLike
 * @typedef {{ _ddContext: import('../opentracing/span_context') }} OtelBridgeSpanContextLike
 * @typedef {{
 *   traceId: string,
 *   spanId: string,
 *   traceFlags?: number,
 *   traceState?: { serialize: () => string }
 * }} OtelSpanContextLike
 * @typedef {DatadogContextLike | OtelBridgeSpanContextLike | OtelSpanContextLike} LinkContextLike
 * @typedef {{ context: LinkContextLike, attributes?: Record<string, unknown> }} OtelLink
 * @typedef {{
 *   name?: string,
 *   message?: string,
 *   stack?: string,
 *   type?: string,
 *   escaped?: unknown
 * }} ExceptionLike
 * @typedef {{
 *   addEvent: (name: string, attributes: Record<string, unknown>, timeInput?: unknown) => unknown
 * }} EventTarget
 */

/**
 * Normalize any Datadog/OTel span-context shape to a `DatadogSpanContext`.
 *
 * @param {LinkContextLike | undefined | null} context
 * @returns {import('../opentracing/span_context') | undefined}
 */
function normalizeLinkContext (context) {
  if (!context) return

  const bridgeCtx = /** @type {OtelBridgeSpanContextLike} */ (context)
  if (bridgeCtx._ddContext) return bridgeCtx._ddContext

  const ddCtx = /** @type {DatadogContextLike} */ (context)
  if (typeof ddCtx.toTraceId === 'function' && typeof ddCtx.toSpanId === 'function') {
    return /** @type {import('../opentracing/span_context')} */ (/** @type {unknown} */ (context))
  }

  const otelCtx = /** @type {OtelSpanContextLike} */ (context)
  if (typeof otelCtx.traceId !== 'string' || typeof otelCtx.spanId !== 'string') return

  let sampling
  if (typeof otelCtx.traceFlags === 'number') {
    sampling = { priority: otelCtx.traceFlags & 1 }
  }

  let tracestate
  if (otelCtx.traceState?.serialize) {
    tracestate = TraceState.fromString(otelCtx.traceState.serialize())
  }

  return new DatadogSpanContext({
    traceId: id(otelCtx.traceId, 16),
    spanId: id(otelCtx.spanId, 16),
    sampling,
    tracestate,
  })
}

/**
 * @param {import('../opentracing/span')} ddSpan
 * @param {string} key
 * @param {unknown} value
 * @returns {void}
 */
function setOtelAttribute (ddSpan, key, value) {
  if (key === 'http.response.status_code') {
    ddSpan.setTag('http.status_code', String(value))
  }

  ddSpan.setTag(key, value)
}

/**
 * @param {import('../opentracing/span')} ddSpan
 * @param {Record<string, unknown>} attributes
 * @returns {void}
 */
function setOtelAttributes (ddSpan, attributes) {
  if ('http.response.status_code' in attributes) {
    attributes['http.status_code'] = String(attributes['http.response.status_code'])
  }

  ddSpan.addTags(attributes)
}

/**
 * Accepts both `{ context, attributes }` and the deprecated `(context, attrs)` form.
 *
 * @param {import('../opentracing/span')} ddSpan
 * @param {LinkContextLike | OtelLink} link
 * @param {Record<string, unknown>} [attrs]
 * @returns {void}
 */
function addOtelLink (ddSpan, link, attrs) {
  // TODO: Drop the (context, attrs) form in v6.0.0.
  const linkObj = link && typeof link === 'object' && 'context' in link
    ? /** @type {OtelLink} */ (link)
    : { context: /** @type {LinkContextLike} */ (link), attributes: attrs ?? {} }

  const ddSpanContext = normalizeLinkContext(linkObj.context)
  if (!ddSpanContext) return

  ddSpan.addLink({ context: ddSpanContext, attributes: linkObj.attributes })
}

/**
 * @param {import('../opentracing/span')} ddSpan
 * @param {EventTarget} eventTarget
 * @param {ExceptionLike} exception
 * @param {unknown} [timeInput]
 * @returns {void}
 */
function recordException (ddSpan, eventTarget, exception, timeInput) {
  ddSpan.addTags({
    [ERROR_TYPE]: exception.name,
    [ERROR_MESSAGE]: exception.message,
    [ERROR_STACK]: exception.stack,
    [IGNORE_OTEL_ERROR]: ddSpan.context()._tags[IGNORE_OTEL_ERROR] ?? true,
  })

  /** @type {Record<string, unknown>} */
  const attributes = {}
  if (exception.message) attributes['exception.message'] = exception.message
  if (exception.type) attributes['exception.type'] = exception.type
  if (exception.escaped) attributes['exception.escaped'] = exception.escaped
  if (exception.stack) attributes['exception.stacktrace'] = exception.stack

  eventTarget.addEvent(exception.name ?? 'Error', attributes, timeInput)
}

/**
 * First-call-wins; no-op on ended spans. Only `code === 2` emits Datadog error tags.
 *
 * @param {import('../opentracing/span')} ddSpan
 * @param {{ ended: boolean, _hasStatus: boolean }} bridgeSpan
 * @param {{ code?: number, message?: string }} [status]
 * @returns {void}
 */
function setStatus (ddSpan, bridgeSpan, { code, message } = {}) {
  if (bridgeSpan.ended || bridgeSpan._hasStatus || !code) return

  bridgeSpan._hasStatus = true

  if (code === 2) {
    ddSpan.addTags({
      [ERROR_MESSAGE]: message,
      [IGNORE_OTEL_ERROR]: false,
    })
  }
}

module.exports = {
  addOtelLink,
  normalizeLinkContext,
  recordException,
  setOtelAttribute,
  setOtelAttributes,
  setStatus,
}
