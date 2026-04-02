'use strict'

/**
 * Returns Datadog trace metadata for RUM<>APM correlation.
 *
 * Call this from your `generateMetadata` function in the root layout to inject
 * `<meta name="dd-trace-id">` and `<meta name="dd-trace-time">` tags into the page.
 * The Datadog RUM SDK reads these on initial page load to link with the server APM trace.
 *
 * Usage:
 * ```js
 * // app/layout.js
 * const { getDatadogTraceMetadata } = require('dd-trace/next')
 *
 * export async function generateMetadata() {
 *   return {
 *     title: 'My App',
 *     ...getDatadogTraceMetadata(),
 *   }
 * }
 * ```
 *
 * Returns a Next.js Metadata-compatible object:
 * { other: { 'dd-trace-id': '<traceId>', 'dd-trace-time': '<timestamp>' } }
 */
function getDatadogTraceMetadata () {
  const tracer = global._ddtrace
  if (!tracer) return {}

  const activeSpan = tracer.scope().active()
  if (!activeSpan) return {}

  const context = activeSpan.context()
  const traceId = context.toTraceId()
  const traceTime = String(Date.now())

  // Generate a span ID that the browser SDK will use for its document resource span.
  // By setting it as the server root span's parentId, the browser span becomes the
  // root of the trace with the server trace nested under it — establishing an explicit
  // parent-child link without relying on clock synchronization.
  const id = require('../../dd-trace/src/id')
  const browserSpanId = id()
  const trace = context._trace
  if (trace && trace.started) {
    for (const span of trace.started) {
      if (!span.context()._parentId) {
        span.context()._parentId = browserSpanId
        break
      }
    }
  } else {
    context._parentId = browserSpanId
  }

  return {
    other: {
      'dd-trace-id': traceId,
      'dd-trace-time': traceTime,
      'dd-root-span-id': browserSpanId.toString(10)
    }
  }
}

module.exports = { getDatadogTraceMetadata }
