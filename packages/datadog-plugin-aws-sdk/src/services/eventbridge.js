'use strict'
const log = require('../../../dd-trace/src/log')
class EventBridge {
  generateTags (params, operation, response) {
    if (!params || !params.source) return {}

    return {
      'resource.name': `${operation} ${params.source}`,
      'aws.eventbridge.source': params.source
    }
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
      request.params.Entries &&
      request.params.Entries.length > 0) {
      try {
        const currentMilliseconds = new Date().getMilliseconds()
        request.params.Entries.forEach(entry => {
          const details = JSON.stringify(entry.Detail)
          details._datadog = {}
          tracer.inject(span, 'text_map', details._datadog)
          details._datadog.ms = currentMilliseconds
          let finalData = JSON.stringify(details)
          const byteSize = Buffer.byteLength(finalData)
          if (byteSize > 256 * 1024) {
            if (byteSize < (1024 * 256) + 11) {
            // The ms field adds 11 bytes. I'd rather drop it and include the rest of the trace context if need be.
              delete details._datadog.ms
              finalData = JSON.stringify(details)
            } else {
              log.info('Payload size too large to pass context')
              return
            }
          }
          entry.Detail = finalData
        })
      } catch (e) {
        log.error(e)
      }
    }
  }
}
module.exports = EventBridge
