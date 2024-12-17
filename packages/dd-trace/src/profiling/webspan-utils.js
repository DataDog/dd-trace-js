const { HTTP_METHOD, HTTP_ROUTE, RESOURCE_NAME, SPAN_TYPE } = require('../../../../ext/tags')
const { WEB } = require('../../../../ext/types')

function isWebServerSpan (tags) {
  return tags[SPAN_TYPE] === WEB
}

function endpointNameFromTags (tags) {
  return tags[RESOURCE_NAME] || [
    tags[HTTP_METHOD],
    tags[HTTP_ROUTE]
  ].filter(v => v).join(' ')
}

function getStartedSpans (context) {
  return context._trace.started
}

module.exports = {
  isWebServerSpan,
  endpointNameFromTags,
  getStartedSpans
}
