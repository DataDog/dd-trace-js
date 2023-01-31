'use strict'

function getRootSpan (tracer) {
  const span = tracer.scope().active()
  return span && span.context()._trace.started[0]
}

module.exports = {
  getRootSpan
}
