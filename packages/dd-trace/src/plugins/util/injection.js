'use strict'

function getHTMLComment (tracer) {
  const traceId = tracer.scope().active().context()._traceId
  const traceTime = Date.now()
  return `<!-- DATADOG;trace-id=${traceId};trace-time=${traceTime} -->\n`
}

function injectRumData (tracer) {
  const span = tracer.scope().active().context()
  span._manualHTMLInjection = true
  const traceId = span._traceId
  const traceTime = Date.now()
  return `\
<meta name="dd-trace-id" content="${traceId}" />\
<meta name="dd-trace-time" content="${traceTime}" />`
}

module.exports = {
  getHTMLComment,
  injectRumData
}
