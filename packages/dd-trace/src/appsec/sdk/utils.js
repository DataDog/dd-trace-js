'use strict'

function getRootSpan (tracer) {
  const span = tracer.scope().active()
  if (!span) return undefined

  const rootSpan = span._spanContext._trace.started[0]
  if (!rootSpan) return undefined
  return rootSpan
}

module.exports = {
  getRootSpan
}
