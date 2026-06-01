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
   * By default only the first entry receives the trace context, mirroring
   * SQS `sendMessageBatch`. Set `batchPropagationEnabled` (plugin config or
   * `DD_TRACE_AWS_SDK_EVENTBRIDGE_BATCH_PROPAGATION_ENABLED`) to inject into
   * every entry in the batch.
   *
   * Each entry is a distinct message: it carries the same trace context but,
   * when DSM is enabled, its own Data Streams pathway checkpoint, so the
   * `_datadog` payload is built per entry rather than shared.
   */
  requestInject (span, request) {
    if (request.operation !== 'putEvents' || !request.params?.Entries?.length) {
      return
    }

    const batchPropagationEnabled = this.config?.batchPropagationEnabled

    for (let i = 0; i < request.params.Entries.length; i++) {
      // Inject only into the first entry by default; opt in to the rest of
      // the batch via `batchPropagationEnabled`.
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
   * Record a Data Streams `direction:out` checkpoint for a single PutEvents
   * entry. The DSM "topic" is the target event bus (the routing destination),
   * defaulting to `default` when the entry omits `EventBusName`.
   *
   * @param {import('../../../..').Span} span
   * @param {{ Detail?: string, EventBusName?: string }} entry
   * @returns {object | undefined} The pathway context to encode, if any.
   */
  setDSMCheckpoint (span, entry) {
    const eventBusName = entry.EventBusName ?? 'default'
    const payloadSize = getSizeOrZero(entry.Detail)
    return this.tracer
      .setCheckpoint(['direction:out', `topic:${eventBusName}`, 'type:eventbridge'], span, payloadSize)
  }
}
module.exports = EventBridge
