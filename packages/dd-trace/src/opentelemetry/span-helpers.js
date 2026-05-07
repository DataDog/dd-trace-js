'use strict'

const { performance } = require('node:perf_hooks')

const { timeInputToHrTime } = require('../../../../vendor/dist/@opentelemetry/core')

const { ERROR_MESSAGE, ERROR_STACK, ERROR_TYPE, IGNORE_OTEL_ERROR } = require('../constants')
const DatadogSpanContext = require('../opentracing/span_context')
const TraceState = require('../opentracing/propagation/tracestate')

const id = require('../id')

const { timeOrigin } = performance

/**
 * @typedef {{
 *   _ddContext?: import('../opentracing/span_context'),
 *   toTraceId?: (get128?: boolean) => string,
 *   toSpanId?: (get128?: boolean) => string,
 *   traceId?: string,
 *   spanId?: string,
 *   traceFlags?: number,
 *   traceState?: { serialize: () => string }
 * }} LinkContextLike
 * @typedef {{ context: LinkContextLike, attributes?: Record<string, unknown> }} OtelLink
 * @typedef {{
 *   name?: string,
 *   message?: string,
 *   stack?: string,
 *   type?: string,
 *   escaped?: unknown
 * }} ExceptionLike
 * @typedef {number | Date | [number, number]} TimeInput
 */

/**
 * @param {import('../opentracing/span')} ddSpan
 */
function isWritable (ddSpan) {
  return ddSpan._duration === undefined
}

/**
 * @param {unknown} value
 * @returns {value is TimeInput}
 */
function isTimeInput (value) {
  return typeof value === 'number' ||
    value instanceof Date ||
    (Array.isArray(value) && value.length === 2 &&
      typeof value[0] === 'number' && typeof value[1] === 'number')
}

/**
 * @param {LinkContextLike} ctx
 * @returns {ctx is import('../opentracing/span_context')}
 */
function isDatadogSpanContext (ctx) {
  return typeof ctx.toTraceId === 'function' && typeof ctx.toSpanId === 'function'
}

/**
 * @param {unknown} link
 * @returns {link is OtelLink}
 */
function isOtelLink (link) {
  return typeof link === 'object' && link !== null && 'context' in link
}

/**
 * The OTel-shipped `hrTimeToMilliseconds` rounds, which drops sub-millisecond precision.
 *
 * @param {TimeInput} [timeInput]
 */
function timeInputToMilliseconds (timeInput) {
  const hrTime = timeInputToHrTime(timeInput || (performance.now() + timeOrigin))
  return hrTime[0] * 1e3 + hrTime[1] / 1e6
}

/**
 * Resolves the OTel `addEvent(name, attributesOrStartTime, startTime)` overloads into a
 * `{ attributes, startTime }` pair where `startTime` is always a millisecond number, so the
 * caller can hand the OTel inputs straight to `DatadogSpan.addEvent` without `Date`/hrTime
 * confusion.
 *
 * @param {Record<string, unknown> | TimeInput | undefined} attributesOrStartTime
 * @param {TimeInput} [startTime]
 */
function normalizeOtelEvent (attributesOrStartTime, startTime) {
  let attributes
  if (attributesOrStartTime) {
    if (isTimeInput(attributesOrStartTime)) {
      startTime = attributesOrStartTime
    } else if (typeof attributesOrStartTime === 'object') {
      attributes = attributesOrStartTime
    }
  }
  return { attributes, startTime: timeInputToMilliseconds(startTime) }
}

/**
 * Accepts the native `DatadogSpanContext` (`toTraceId`/`toSpanId`), the bridge wrapper
 * (`_ddContext`), or a standard OTel `SpanContext` (`traceId`/`spanId` strings); returns
 * a `DatadogSpanContext` or `undefined` when nothing usable is present.
 *
 * @param {LinkContextLike | undefined | null} context
 */
function normalizeLinkContext (context) {
  if (!context) return

  if (context._ddContext) return context._ddContext

  if (isDatadogSpanContext(context)) return context

  if (typeof context.traceId !== 'string' || typeof context.spanId !== 'string') return

  let sampling
  if (typeof context.traceFlags === 'number') {
    sampling = { priority: context.traceFlags & 1 }
  }

  let tracestate
  if (context.traceState?.serialize) {
    tracestate = TraceState.fromString(context.traceState.serialize())
  }

  return new DatadogSpanContext({
    traceId: id(context.traceId, 16),
    spanId: id(context.spanId, 16),
    sampling,
    tracestate,
  })
}

/**
 * Mirrors `http.response.status_code` onto `http.status_code` (DD's special tag used by APM
 * trace metrics and client-side stats); both names end up on the span.
 *
 * @param {import('../opentracing/span')} ddSpan
 * @param {string} key
 * @param {unknown} value
 */
function setOtelAttribute (ddSpan, key, value) {
  if (!isWritable(ddSpan)) return

  if (key === 'http.response.status_code') {
    ddSpan.setTag('http.status_code', String(value))
  }

  ddSpan.setTag(key, value)
}

/**
 * Same `http.status_code` mirror as `setOtelAttribute`; does not mutate the caller's
 * `attributes` object.
 *
 * @param {import('../opentracing/span')} ddSpan
 * @param {Record<string, unknown>} attributes
 */
function setOtelAttributes (ddSpan, attributes) {
  if (!isWritable(ddSpan)) return

  ddSpan.addTags(attributes)
  if ('http.response.status_code' in attributes) {
    ddSpan.setTag('http.status_code', String(attributes['http.response.status_code']))
  }
}

/**
 * Accepts both `{ context, attributes }` and the deprecated `(context, attrs)` form.
 *
 * @param {import('../opentracing/span')} ddSpan
 * @param {LinkContextLike | OtelLink} link
 * @param {Record<string, unknown>} [attrs]
 */
function addOtelLink (ddSpan, link, attrs) {
  if (!isWritable(ddSpan) || !link) return

  // TODO: Drop the (context, attrs) form in v6.0.0.
  const { context, attributes } = isOtelLink(link)
    ? link
    : { context: link, attributes: attrs ?? {} }

  const ddSpanContext = normalizeLinkContext(context)
  if (!ddSpanContext) return

  ddSpan.addLink({ context: ddSpanContext, attributes })
}

/**
 * Forwards the array-form `addLinks` overload; non-array inputs are silently ignored to
 * match the OTel API's lenient handling.
 *
 * @param {import('../opentracing/span')} ddSpan
 * @param {Array<LinkContextLike | OtelLink>} links
 */
function addOtelLinks (ddSpan, links) {
  if (!isWritable(ddSpan) || !Array.isArray(links)) return

  for (const link of links) {
    addOtelLink(ddSpan, link)
  }
}

/**
 * Owns the OTel `addEvent(name, attributesOrStartTime, startTime)` overload normalization so
 * the bridge classes can delegate without touching `Date`/hrTime conversion.
 *
 * @param {import('../opentracing/span')} ddSpan
 * @param {string} name
 * @param {Record<string, unknown> | TimeInput | undefined} [attributesOrStartTime]
 * @param {TimeInput} [startTime]
 */
function addOtelEvent (ddSpan, name, attributesOrStartTime, startTime) {
  if (!isWritable(ddSpan)) return

  const event = normalizeOtelEvent(attributesOrStartTime, startTime)
  ddSpan.addEvent(name, event.attributes, event.startTime)
}

/**
 * @param {import('../opentracing/span')} ddSpan
 * @param {ExceptionLike} exception
 * @param {TimeInput} [timeInput]
 */
function recordException (ddSpan, exception, timeInput) {
  if (!isWritable(ddSpan)) return

  ddSpan.addTags({
    [ERROR_TYPE]: exception.name,
    [ERROR_MESSAGE]: exception.message,
    [ERROR_STACK]: exception.stack,
    [IGNORE_OTEL_ERROR]: ddSpan.context()._tags[IGNORE_OTEL_ERROR] ?? true,
  })

  const attributes = {}
  if (exception.message) attributes['exception.message'] = exception.message
  if (exception.type) attributes['exception.type'] = exception.type
  if (exception.escaped) attributes['exception.escaped'] = exception.escaped
  if (exception.stack) attributes['exception.stacktrace'] = exception.stack

  ddSpan.addEvent(exception.name ?? 'Error', attributes, timeInputToMilliseconds(timeInput))
}

/**
 * Applies OTel `setStatus({ code, message })` per spec: UNSET / missing is a no-op, OK is
 * final, ERROR is replaceable. Only ERROR writes tags; the returned code is the one the
 * caller must store for the next call.
 *
 * @param {import('../opentracing/span')} ddSpan
 * @param {number} currentCode 0 = UNSET, 1 = OK, 2 = ERROR.
 * @param {{ code?: number, message?: string }} [status]
 * @returns {number} The new status code to track on the caller.
 */
function applyOtelStatus (ddSpan, currentCode, status) {
  if (!isWritable(ddSpan)) return currentCode

  const code = status?.code
  if (!code || currentCode === 1) return currentCode

  if (code === 2) {
    ddSpan.addTags({
      [ERROR_MESSAGE]: status.message,
      [IGNORE_OTEL_ERROR]: false,
    })
  }

  return code
}

/**
 * OTel `updateName` for OTel-created bridge spans: writes the DD operation name, matching
 * the OTel SDK semantic that `updateName` updates the canonical span identifier.
 *
 * @param {import('../opentracing/span')} ddSpan
 * @param {string} name
 */
function setOtelOperationName (ddSpan, name) {
  if (!isWritable(ddSpan)) return

  ddSpan.setOperationName(name)
}

/**
 * OTel `updateName` for DD-native spans the bridge did not create: writes `resource.name`
 * so the operation name (and the backend metric aggregation it drives) stays stable.
 *
 * @param {import('../opentracing/span')} ddSpan
 * @param {string} name
 */
function setOtelResource (ddSpan, name) {
  if (!isWritable(ddSpan)) return

  ddSpan.setTag('resource.name', name)
}

module.exports = {
  addOtelEvent,
  addOtelLink,
  addOtelLinks,
  applyOtelStatus,
  normalizeLinkContext,
  recordException,
  setOtelAttribute,
  setOtelAttributes,
  setOtelOperationName,
  setOtelResource,
}
