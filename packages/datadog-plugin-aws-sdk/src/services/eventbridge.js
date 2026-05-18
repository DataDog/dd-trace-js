'use strict'

const {
  DsmPathwayCodec,
  getHeadersSize,
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
    const dsmEnabled = this.config?.dsmEnabled === true
    const batchPropagationEnabled = this.config?.batchPropagationEnabled === true
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
    if (!dsmEnabled) {
      if (!injectTraceContext) return

      const ddInfo = {}
      this.tracer.inject(span, 'text_map', ddInfo)
      const finalData = this.injectDetail(entry.Detail, ddInfo)
      if (finalData) {
        entry.Detail = finalData
      }
      return
    }

    const originalDetail = entry.Detail
    const ddInfo = {}
    if (injectTraceContext) {
      this.tracer.inject(span, 'text_map', ddInfo)
    }

    let finalData = this.injectDetail(originalDetail, ddInfo)
    if (!finalData) return

    entry.Detail = finalData
    const dataStreamsContext = this.setDSMCheckpoint(span, entry)
    if (!dataStreamsContext) {
      if (!injectTraceContext) {
        entry.Detail = originalDetail
        return
      }
      return
    }

    DsmPathwayCodec.encode(dataStreamsContext, ddInfo)
    finalData = this.injectDetail(originalDetail, ddInfo)
    if (!finalData) {
      entry.Detail = originalDetail
      return
    }

    entry.Detail = finalData
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
   * @returns {object|null|undefined}
   */
  setDSMCheckpoint (span, entry) {
    const eventBus = entry.EventBusName || DEFAULT_EVENT_BUS
    const detailType = entry.DetailType || DEFAULT_DETAIL_TYPE
    const payloadSize = getHeadersSize(entry)
    return this.tracer.setCheckpoint(
      ['direction:out', `type:eventbridge:${eventBus}`, `topic:${detailType}`],
      span,
      payloadSize,
    )
  }
}
module.exports = EventBridge
