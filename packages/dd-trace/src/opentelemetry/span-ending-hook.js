'use strict'

// Pre-finish hook for OTel-bridge spans. `Span.end()` runs it before `finish()` formats and
// (synchronously, for the last span in a trace) exports the trace, so a framework instrumentation
// can rewrite the operation name / resource while the DD span is still unfinished; `onEnd` only sees
// the already-built payload. Its own dependency-free module so an instrumentation can register
// without loading the OTel bridge, and a plain holder so the caller gates on `hook` existing.

/** @type {{ hook: ((ddSpan: import('../opentracing/span')) => void) | undefined }} */
module.exports = { hook: undefined }
