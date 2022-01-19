'use strict'
const log = require('../../../dd-trace/src/log')
class Eventbridge {
  generateTags (params, operation, response) {
    const tags = {}

    if (!params || !params.source) return tags

    return Object.assign(tags, {
      'resource.name': `${operation} ${params.source}`,
      'aws.eventbridge.source': params.source
    })
  }

  requestInject (span, request, tracer) {
    const operation = request.operation
    if (operation === 'putEvents' &&
      request.params &&
      request.params.Entries.length > 0 &&
      request.params.Entries[0].Detail) {
      try {
        const details = JSON.parse(request.params.Entries[0].Detail)
        details._datadog = {}
        tracer.inject(span, 'text_map', details._datadog)
        request.params.Entries[0].Detail = JSON.stringify(details)
      } catch (e) {
        log.error(e)
      }
    }
  }
}
module.exports = Eventbridge
