'use strict'

const {
  DsmPathwayCodec,
  getHeadersSize,
  getSizeOrZero,
} = require('../../../dd-trace/src/datastreams')
const log = require('../../../dd-trace/src/log')
const BaseAwsSdkPlugin = require('../base')

const DEFAULT_EVENT_BUS = 'default'
const DEFAULT_DETAIL_TYPE = 'unknown'
const MAX_EVENT_SIZE = 1024 * 256

class EventBridge extends BaseAwsSdkPlugin {
  static id = 'eventbridge'
  static isPayloadReporter = true

  generateTags (params, operation, response) {
    if (!params?.source) return
    const rulename = params.Name ?? ''
    return {
      'resource.name': operation
        ? `${operation} ${params.source}`
        : params.source,
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
    const { operation, params } = request
    if (operation !== 'putEvents' || !params?.Entries?.length) return
    const dsmEnabled = this.config.dsmEnabled
    const batchPropagationEnabled = this.config.batchPropagationEnabled
    if (dsmEnabled || batchPropagationEnabled) {
      for (let i = 0; i < params.Entries.length; i++) {
        this.injectToEntry(
          span,
          params.Entries[i],
          i === 0 || batchPropagationEnabled,
          dsmEnabled,
        )
      }
      return
    }

    this.injectToEntry(span, params.Entries[0], true, false)
  }

  /**
   * Inject trace and optional DSM context into a single PutEvents entry.
   *
   * @param {import('../../../..').Span} span
   * @param {object} entry
   * @param {boolean} injectTraceContext
   * @param {boolean} dsmEnabled
   * @returns {void}
   */
  injectToEntry (span, entry, injectTraceContext, dsmEnabled) {
    if (!entry?.Detail) return

    let hasDdInfo = false
    const ddInfo = {}
    if (injectTraceContext) {
      this.tracer.inject(span, 'text_map', ddInfo)
      hasDdInfo = true
    }

    if (dsmEnabled) {
      // Measure with the trace context so the reported payload size matches the
      // on-wire payload, then fold the encoded pathway into a copy. `ddInfo`
      // stays trace-only so we can fall back to it below if the combined
      // payload no longer fits within the per-entry size limit.
      const dataStreamsContext = this.setDSMCheckpoint(span, entry, ddInfo)
      if (dataStreamsContext) {
        const carrier = { ...ddInfo }
        DsmPathwayCodec.encode(dataStreamsContext, carrier)
        const finalData = this.injectDetail(entry.Detail, carrier)
        if (finalData) {
          entry.Detail = finalData
          return
        }
      }
    }

    if (!hasDdInfo) return

    const finalData = this.injectDetail(entry.Detail, ddInfo)
    if (finalData) {
      entry.Detail = finalData
    }
  }

  /**
   * Inject the `_datadog` field into a JSON detail string and reject
   * payloads that would exceed EventBridge's per-entry size limit.
   *
   * @param {string} detail
   * @param {object} ddInfo
   * @returns {string|undefined}
   */
  injectDetail (detail, ddInfo) {
    let finalData
    try {
      finalData = BaseAwsSdkPlugin.injectFieldIntoJsonObject(
        detail,
        '_datadog',
        ddInfo,
      )
    } catch (error) {
      log.error('EventBridge error injecting request', error)
      return
    }

    if (Buffer.byteLength(finalData, 'utf8') >= MAX_EVENT_SIZE) {
      log.info('Payload size too large to pass context')
      return
    }

    return finalData
  }

  /**
   * Set a DSM checkpoint for a single EventBridge entry.
   *
   * @param {import('../../../..').Span} span
   * @param {object} entry
   * @param {object} [ddInfo] trace context folded into the measured payload size
   * @returns {object|null|undefined}
   */
  setDSMCheckpoint (span, entry, ddInfo) {
    const eventBus = entry.EventBusName || DEFAULT_EVENT_BUS
    const detailType = entry.DetailType || DEFAULT_DETAIL_TYPE
    const payloadSize = getHeadersSize(entry) + getSizeOrZero(ddInfo)
    return this.tracer.setCheckpoint(
      ['direction:out', `exchange:${eventBus}`, `topic:${detailType}`, 'type:eventbridge'],
      span,
      payloadSize,
    )
  }
}
module.exports = EventBridge
