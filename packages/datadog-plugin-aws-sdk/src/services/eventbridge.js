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
// EventBridge enforces this limit over the whole PutEvents request (the sum of
// every entry), not over a single entry. 1 MiB == 1,048,576 bytes.
const MAX_PUT_EVENTS_BYTES = 1024 * 1024

/**
 * Size a single `PutEventsRequestEntry` the way EventBridge does server-side:
 * the UTF-8 byte length of `Source`, `DetailType`, `Detail`, and each
 * `Resources` ARN, plus a flat 14 bytes when `Time` is set.
 *
 * @param {object} entry a single PutEvents request entry
 * @param {string} [detail] overrides `entry.Detail`, used to size the entry as
 *   it would be sent with the injected `_datadog` context
 * @returns {number}
 * @see https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-putevents.html
 */
function putEventEntrySize (entry, detail = entry.Detail) {
  let size = entry.Time == null ? 0 : 14
  if (entry.Source != null) size += Buffer.byteLength(entry.Source)
  if (entry.DetailType != null) size += Buffer.byteLength(entry.DetailType)
  if (detail != null) size += Buffer.byteLength(detail)
  if (entry.Resources != null) {
    for (const resource of entry.Resources) {
      if (resource != null) size += Buffer.byteLength(resource)
    }
  }
  return size
}

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
   * Max PutEvents request size is 1mb, summed over all entries
   * (https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-putevent-size.html)
   */
  requestInject (span, request) {
    const { operation, params } = request
    if (operation !== 'putEvents' || !params?.Entries?.length) return

    const entries = params.Entries
    const dsmEnabled = this.config.dsmEnabled
    const batchPropagationEnabled = this.config.batchPropagationEnabled
    const injectedDetails = new Array(entries.length)
    let hasInjectedDetail = false

    for (let i = 0; i < entries.length; i++) {
      const injectTraceContext = i === 0 || batchPropagationEnabled
      if (!dsmEnabled && !injectTraceContext) continue

      const finalData = this.getInjectedEntryDetail(
        span,
        entries[i],
        injectTraceContext,
        dsmEnabled,
      )

      if (finalData !== undefined) {
        injectedDetails[i] = finalData
        hasInjectedDetail = true
      }
    }

    if (!hasInjectedDetail) return

    // EventBridge applies the 1 MiB cap to the whole request, so size every
    // entry as it would be sent (the injected entries with `_datadog`) and skip
    // rather than tip a request AWS would otherwise accept over the limit. The
    // running total only needs to clear the cap, so stop summing the moment it
    // does instead of byte-counting the rest of a batch we already know is over.
    let requestSize = 0
    for (let i = 0; requestSize < MAX_PUT_EVENTS_BYTES && i < entries.length; i++) {
      requestSize += putEventEntrySize(entries[i], injectedDetails[i] ?? entries[i].Detail)
    }
    if (requestSize >= MAX_PUT_EVENTS_BYTES) {
      log.info('Payload size too large to pass context')
      return
    }

    for (let i = 0; i < entries.length; i++) {
      if (injectedDetails[i] !== undefined) {
        entries[i].Detail = injectedDetails[i]
      }
    }
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
    const finalData = this.getInjectedEntryDetail(
      span,
      entry,
      injectTraceContext,
      dsmEnabled,
    )
    if (finalData !== undefined) {
      entry.Detail = finalData
    }
  }

  /**
   * Build the injected detail string for a single EventBridge entry.
   *
   * @param {import('../../../..').Span} span
   * @param {object} entry
   * @param {boolean} injectTraceContext
   * @param {boolean} dsmEnabled
   * @returns {string|undefined}
   */
  getInjectedEntryDetail (span, entry, injectTraceContext, dsmEnabled) {
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
      // payload no longer fits or should not be propagated.
      const dataStreamsContext = this.setDSMCheckpoint(span, entry, ddInfo)
      if (dataStreamsContext) {
        const carrier = { ...ddInfo }
        DsmPathwayCodec.encode(dataStreamsContext, carrier)
        const finalData = this.injectDetail(entry.Detail, carrier)
        if (finalData !== undefined) {
          return finalData
        }
      }
    }

    if (!hasDdInfo) return

    return this.injectDetail(entry.Detail, ddInfo)
  }

  /**
   * Inject the `_datadog` field into a JSON detail string.
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
