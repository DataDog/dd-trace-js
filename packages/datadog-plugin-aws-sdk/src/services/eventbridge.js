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
// DSM adds a fixed 'dd-pathway-ctx-base64' key to the _datadog object.
// The pathway context is always 20 bytes binary → 28 chars in base64.
// Full JSON contribution: ,"dd-pathway-ctx-base64":"<28 chars>" = 55 bytes.
const DSM_PATHWAY_FIELD_BYTES = 55

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
      'aws.eventbridge.source': params.source,
      'messaging.system': 'aws_eventbridge',
      rulename,
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

    // Only the entries we actually injected into. Each carries its own entry
    // reference so the write pass doesn't need a parallel index into `entries`.
    const results = []
    let requestSize = 0

    // Build trace-only details and size the request as it would ship.
    // A malformed Detail (injectDetail -> undefined) is skipped, not fatal:
    // EventBridge partial-fails only that entry, so the rest still propagate.
    for (let i = 0; i < entries.length && requestSize < MAX_PUT_EVENTS_BYTES; i++) {
      const entry = entries[i]
      const injectTraceContext = i === 0 || batchPropagationEnabled
      if ((injectTraceContext || dsmEnabled) && entry.Detail) {
        const carrier = {}
        if (injectTraceContext) this.tracer.inject(span, 'text_map', carrier)
        const traceOnlyDetail = this.injectDetail(entry.Detail, carrier)
        if (traceOnlyDetail !== undefined) {
          results.push({ entry, carrier, traceOnlyDetail })
          requestSize += putEventEntrySize(entry, traceOnlyDetail) + (dsmEnabled ? DSM_PATHWAY_FIELD_BYTES : 0)
          continue
        }
      }
      requestSize += putEventEntrySize(entry)
    }

    if (results.length === 0) return
    if (requestSize >= MAX_PUT_EVENTS_BYTES) {
      log.info('Payload size too large to pass context')
      return
    }

    for (const { entry, carrier, traceOnlyDetail } of results) {
      if (dsmEnabled) {
        const dataStreamsContext = this.setDSMCheckpoint(span, entry, carrier)
        if (dataStreamsContext) {
          DsmPathwayCodec.encode(dataStreamsContext, carrier)
          const withDsm = this.injectDetail(entry.Detail, carrier)
          if (withDsm !== undefined) {
            entry.Detail = withDsm
            continue
          }
        }
      }
      entry.Detail = traceOnlyDetail
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

    const ddInfo = {}
    if (injectTraceContext) {
      this.tracer.inject(span, 'text_map', ddInfo)
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

    if (!injectTraceContext) return

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
      [
        'direction:out',
        `exchange:${eventBus}`,
        `topic:${detailType}`,
        'type:eventbridge',
      ],
      span,
      payloadSize,
    )
  }
}
module.exports = EventBridge
