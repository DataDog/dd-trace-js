'use strict'
const log = require('../../../dd-trace/src/log')
const BaseAwsSdkPlugin = require('../base')

class EventBridge extends BaseAwsSdkPlugin {
  static get id () { return 'eventbridge' }
  static get isPayloadReporter () { return true }

  generateTags (params, operation, response) {
    const rulename = params.Name ? params.Name : ''
    const source = `${params.Entries[0].Source}`.replace(/^event/i, '')
    return {
      'resource.name': operation ? `${operation} ${source}` : source,
      'aws.eventbridge.source': source,
      'peer.service': source, //CANNOT MODIFY IDK WHY
      'rulename': `${rulename}`,
      'hostname': `events.${this.activeSpan._spanContext._tags['region']}.amazonaws.com`,
    }
  }

  /**
   * requestInject
   * @param {*} span
   * @param {*} request
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
        const details = JSON.parse(request.params.Entries[0].Detail)
        details._datadog = {}
        this.tracer.inject(span, 'text_map', details._datadog)
        const finalData = JSON.stringify(details)
        const byteSize = Buffer.byteLength(finalData)
        if (byteSize >= (1024 * 256)) {
          log.info('Payload size too large to pass context')
          return
        }
        request.params.Entries[0].Detail = finalData
      } catch (e) {
        log.error('EventBridge error injecting request', e)
      }
    }
  }
}
module.exports = EventBridge
