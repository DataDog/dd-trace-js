'use strict'
const log = require('../../../dd-trace/src/log')
const BaseAwsSdkPlugin = require('../base')

class EventBridge extends BaseAwsSdkPlugin {
  static id = 'eventbridge'
  static isPayloadReporter = true

  generateTags (params, operation, response) {
    if (!params?.source) return {}
    const rulename = params.Name ?? ''
    return {
      'resource.name': operation ? `${operation} ${params.source}` : params.source,
      'aws.eventbridge.source': `${params.source}`,
      'messaging.system': 'aws_eventbridge',
      rulename: `${rulename}`,
    }
  }

  /**
   * requestInject
   * @param {import('../../../..').Span} span
   * @param {object} request
   *
   * Docs: https://docs.aws.amazon.com/eventbridge/latest/APIReference/API_PutEventsRequestEntry.html
   * We cannot use the traceHeader field as that's reserved for X-Ray.
   * Detail must be a valid JSON string
   * Max size per event is 256kb (https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-putevent-size.html)
   */
  requestInject (span, request) {
    const operation = request.operation
    if (operation === 'putEvents' &&
      request.params &&
      request.params.Entries &&
      request.params.Entries.length > 0 &&
      request.params.Entries[0].Detail) {
      try {
        const injected = {}
        this.tracer.inject(span, 'text_map', injected)
        const finalData = BaseAwsSdkPlugin.injectFieldIntoJsonObject(
          request.params.Entries[0].Detail, '_datadog', injected
        )
        const byteSize = Buffer.byteLength(finalData)
        if (byteSize >= (1024 * 256)) {
          log.info('Payload size too large to pass context')
          return
        }
        request.params.Entries[0].Detail = finalData
      } catch (error) {
        log.error('EventBridge error injecting request', error)
      }
    }
  }
}
module.exports = EventBridge
