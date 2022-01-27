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

  /**
   * requestInject
   * @param {*} span
   * @param {*} request
   * @param {*} tracer
   *
   * Docs: https://docs.aws.amazon.com/eventbridge/latest/APIReference/API_PutEventsRequestEntry.html
   * We cannot use the traceHeader field as that's reserved for X-Ray.
   * Detail must be a valid JSON string
   * Max size per event is 256kb (https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-putevent-size.html)
   */
  requestInject (span, request, tracer) {
    const operation = request.operation
    if (operation === 'putEvents' &&
      request.params &&
      request.params.Entries.length > 0 &&
      request.params.Entries[0].Detail) {
      try {
        const byteSize = Buffer.byteLength(request.params.Entries[0].Detail)
        if (byteSize + 512 >= 256000) {
          log.info('Payload size too large to pass context')
          return
        }
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
