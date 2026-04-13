'use strict'

const id = require('../../dd-trace/src/id')

/**
 * Returns Datadog trace metadata for RUM<>APM correlation.
 *
 * Call this from your `generateMetadata` function in the root layout to inject
 * `<meta name="dd-trace-id">`, `<meta name="dd-trace-time">`, and
 * `<meta name="dd-root-span-id">` tags into the page. The Datadog RUM SDK reads
 * these on initial page load to link with the server APM trace.
 *
 * For RSC (React Server Component) fetches initiated by the browser SDK's trace
 * header injection, meta tags are suppressed to avoid overwriting the document's
 * original trace context during client-side navigation.
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
 */
function getDatadogTraceMetadata () {
  const tracer = global._ddtrace
  if (!tracer) return {}

  const activeSpan = tracer.scope().active()
  if (!activeSpan) return {}

  const context = activeSpan.context()

  // Skip meta tag emission for RSC fetches that already have a RUM-injected parent.
  // The RUM SDK sets x-datadog-origin: 'rum' which dd-trace stores as _trace.origin.
  // For these requests the browser already has the trace context — emitting meta tags
  // would overwrite the document's original trace data during client-side navigation.
  const origin = context._trace && context._trace.origin
  if (origin === 'rum') {
    return {}
  }

  // Return cached metadata if already computed for this trace, avoiding
  // repeated re-parenting when generateMetadata is called multiple times
  // (e.g., from nested layouts).
  if (context._ddBrowserSpanId) {
    return {
      other: {
        'dd-trace-id': context.toTraceId(),
        'dd-trace-time': String(Date.now()),
        'dd-root-span-id': context._ddBrowserSpanId.toString(10),
      },
    }
  }

  const traceId = context.toTraceId()
  const traceTime = String(Date.now())

  // Generate a span ID that the browser SDK will use for its document resource span.
  // By setting it as the server root span's parentId, the browser span becomes the
  // root of the trace with the server trace nested under it — establishing an explicit
  // parent-child link without relying on clock synchronization.
  //
  // NOTE: This mutates internal DatadogSpanContext fields (_parentId, _trace.started).
  // If those internals change, this re-parenting logic must be updated accordingly.
  const browserSpanId = id()
  context._ddBrowserSpanId = browserSpanId

  const trace = context._trace
  if (trace?.started?.length) {
    for (const span of trace.started) {
      const spanContext = span.context?.()
      if (spanContext && !spanContext._parentId) {
        spanContext._parentId = browserSpanId
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
      'dd-root-span-id': browserSpanId.toString(10),
    },
  }
}

module.exports = { getDatadogTraceMetadata }
