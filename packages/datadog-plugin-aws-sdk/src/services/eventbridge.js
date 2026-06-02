'use strict'
const { DsmPathwayCodec, getSizeOrZero } = require('../../../dd-trace/src/datastreams')
const log = require('../../../dd-trace/src/log')
const BaseAwsSdkPlugin = require('../base')

class EventBridge extends BaseAwsSdkPlugin {
  static id = 'eventbridge'
  static isPayloadReporter = true

  generateTags (params, operation, response) {
    if (!params?.source) return
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
   *
   * Injects only the first entry by default (like SQS `sendMessageBatch`); set
   * `batchPropagationEnabled` (or `DD_TRACE_AWS_SDK_EVENTBRIDGE_BATCH_PROPAGATION_ENABLED`)
   * for the whole batch. `_datadog` is built per entry since each carries its own
   * DSM pathway when DSM is enabled.
   */
  requestInject (span, request) {
    if (request.operation !== 'putEvents' || !request.params?.Entries?.length) {
      return
    }

    const batchPropagationEnabled = this.config?.batchPropagationEnabled

    for (let i = 0; i < request.params.Entries.length; i++) {
      // First entry only by default; the rest require batchPropagationEnabled.
      if (i > 0 && !batchPropagationEnabled) break

      const entry = request.params.Entries[i]
      if (!entry?.Detail) continue

      const ddInfo = {}
      this.tracer.inject(span, 'text_map', ddInfo)

      if (this.config?.dsmEnabled) {
        const dataStreamsContext = this.setDSMCheckpoint(span, entry)
        if (dataStreamsContext) {
          DsmPathwayCodec.encode(dataStreamsContext, ddInfo)
        }
      }

      // Only `injectFieldIntoJsonObject` can throw (the slow path
      // `JSON.parse` for non-`{...}` payloads). Tighten the catch around
      // it so the rest of the body stays in V8's optimisable surface.
      let finalData
      try {
        finalData = BaseAwsSdkPlugin.injectFieldIntoJsonObject(
          entry.Detail, '_datadog', ddInfo
        )
      } catch (error) {
        log.error('EventBridge error injecting request', error)
        continue
      }

      if (Buffer.byteLength(finalData) >= 1024 * 256) {
        log.info('Payload size too large to pass context')
        continue
      }
      entry.Detail = finalData
    }
  }

  /**
   * Records a Data Streams `direction:out` checkpoint for one PutEvents entry.
   * The DSM topic is the target event bus (`EventBusName`, default `default`).
   *
   * @param {import('../../../..').Span} span
   * @param {{ Detail?: string, EventBusName?: string }} entry
   * @returns {object | undefined}
   */
  setDSMCheckpoint (span, entry) {
    const eventBusName = entry.EventBusName ?? 'default'
    const payloadSize = getSizeOrZero(entry.Detail)
    return this.tracer
      .setCheckpoint(['direction:out', `topic:${eventBusName}`, 'type:eventbridge'], span, payloadSize)
  }
}
module.exports = EventBridge
