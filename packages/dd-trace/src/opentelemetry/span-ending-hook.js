'use strict'

// A single pre-finish hook for OTel-bridge spans. `Span.end()` runs it while the DD span is
// still unfinished, so a framework instrumentation can rewrite the operation name / resource
// before `finish()` formats and (synchronously, for the last span in a trace) exports it. `onEnd`
// would only ever see the already-built payload.
//
// This lives in its own dependency-free module — no `@opentelemetry/api`, no tracer — so an
// instrumentation can register a hook without dragging the OTel bridge into processes that never
// use it. A single hook is enough: the tracer owns the sole caller and Next.js the sole registrant.

let spanEndingHook

/**
 * @param {(ddSpan: import('../opentracing/span')) => void} hook
 */
function setSpanEndingHook (hook) {
  spanEndingHook = hook
}

/**
 * @param {import('../opentracing/span')} ddSpan
 */
function runSpanEndingHook (ddSpan) {
  spanEndingHook?.(ddSpan)
}

module.exports = { runSpanEndingHook, setSpanEndingHook }
