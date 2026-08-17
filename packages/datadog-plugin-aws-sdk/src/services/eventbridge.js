'use strict'

const { DsmPathwayCodec, PATHWAY_FIELD_BYTES } = require('../../../dd-trace/src/datastreams')
const log = require('../../../dd-trace/src/log')
const BaseAwsSdkPlugin = require('../base')

const DEFAULT_EVENT_BUS = 'default'
const DEFAULT_DETAIL_TYPE = 'unknown'
// EventBridge enforces this limit over the whole PutEvents request (the sum of
// every entry), not over a single entry.
const MAX_PUT_EVENTS_BYTES = 1024 * 1024
// Sizing runs before any checkpoint exists, so entries that carry nothing but a pathway are
// measured against this stand-in.
const PATHWAY_SIZE_PROBE = { hash: Buffer.alloc(8), pathwayStartNs: 0, edgeStartNs: 0 }

/**
 * @typedef {object} PutEventsRequestEntry
 * @property {string} [Detail]
 * @property {string} [DetailType]
 * @property {string} [EventBusName]
 * @property {string[]} [Resources]
 * @property {string} [Source]
 * @property {Date} [Time]
 * @property {string} [TraceHeader]
 */

/**
 * Size a single entry the way DSM reports payloads across tracers: the UTF-8 byte length of every
 * string field the caller supplied. `Time` is excluded because it is not part of the message the
 * consumer receives, which is also why this differs from `putEventEntrySize`.
 *
 * @param {PutEventsRequestEntry} entry whose `Detail` the caller has already checked is a string.
 * @returns {number}
 */
function dsmPayloadSize (entry) {
  let size = Buffer.byteLength(entry.Detail)
  if (typeof entry.DetailType === 'string') size += Buffer.byteLength(entry.DetailType)
  if (typeof entry.EventBusName === 'string') size += Buffer.byteLength(entry.EventBusName)
  if (typeof entry.Source === 'string') size += Buffer.byteLength(entry.Source)
  if (typeof entry.TraceHeader === 'string') size += Buffer.byteLength(entry.TraceHeader)
  if (Array.isArray(entry.Resources)) {
    for (const resource of entry.Resources) {
      if (typeof resource === 'string') size += Buffer.byteLength(resource)
    }
  }
  return size
}

/**
 * Size a single `PutEventsRequestEntry` the way EventBridge does server-side:
 * the UTF-8 byte length of `Source`, `DetailType`, `Detail`, and each
 * `Resources` ARN, plus a flat 14 bytes when `Time` is set.
 *
 * @param {PutEventsRequestEntry} entry
 * @param {string} [detail] overrides `entry.Detail`, used to size the entry as
 *   it would be sent with the injected `_datadog` context
 * @see https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-putevents.html
 */
function putEventEntrySize (entry, detail) {
  if (entry == null) return 0

  detail ??= entry.Detail
  let size = entry.Time == null ? 0 : 14
  if (typeof entry.Source === 'string') size += Buffer.byteLength(entry.Source)
  if (typeof entry.DetailType === 'string') size += Buffer.byteLength(entry.DetailType)
  if (typeof detail === 'string') size += Buffer.byteLength(detail)
  if (Array.isArray(entry.Resources)) {
    for (const resource of entry.Resources) {
      if (typeof resource === 'string') size += Buffer.byteLength(resource)
    }
  }
  return size
}

/**
 * @param {string} detail
 * @param {Record<string, string>} carrier
 * @returns {string|undefined} `undefined` when `detail` is not a JSON object
 */
function injectDetail (detail, carrier) {
  try {
    return BaseAwsSdkPlugin.injectFieldIntoJsonObject(detail, '_datadog', carrier)
  } catch (error) {
    log.error('EventBridge error injecting request', error)
  }
}

class EventBridge extends BaseAwsSdkPlugin {
  static id = 'eventbridge'
  static isPayloadReporter = true

  generateTags (params, operation, response) {
    if (!params?.source) return
    const rulename = params.Name ?? ''
    return {
      'resource.name': operation ? `${operation} ${params.source}` : params.source,
      'aws.eventbridge.source': params.source,
      'messaging.system': 'aws_eventbridge',
      rulename,
    }
  }

  /**
   * The context goes into `Detail` because EventBridge reserves an entry's `TraceHeader` for X-Ray.
   *
   * @param {import('../../../..').Span} span
   * @param {{ operation: string, params?: { Entries?: PutEventsRequestEntry[] } }} request
   * @see https://docs.aws.amazon.com/eventbridge/latest/APIReference/API_PutEventsRequestEntry.html
   * @see https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-putevent-size.html
   */
  requestInject (span, request) {
    const { operation, params } = request
    if (operation !== 'putEvents' || !params?.Entries?.length) return

    const entries = params.Entries
    const dsmEnabled = this.config.dsmEnabled
    const batchPropagationEnabled = this.config.batchPropagationEnabled
    const traceCarrier = this.tracer.inject(span, 'text_map')
    if (traceCarrier === undefined && !dsmEnabled) return

    // The default configuration injects the first entry alone and records no checkpoint, so it
    // needs none of the deferred-write bookkeeping the paths below depend on.
    if (!dsmEnabled && !batchPropagationEnabled) {
      const entry = entries[0]
      if (typeof entry?.Detail !== 'string') return
      const detail = injectDetail(entry.Detail, traceCarrier)
      if (detail === undefined) return
      let requestSize = putEventEntrySize(entry, detail)
      for (let i = 1; requestSize < MAX_PUT_EVENTS_BYTES && i < entries.length; i++) {
        requestSize += putEventEntrySize(entries[i])
      }
      if (requestSize >= MAX_PUT_EVENTS_BYTES) {
        log.info('Payload size too large to pass context')
        return
      }
      entry.Detail = detail
      return
    }

    // Both carriers are reused across entries; the write pass overwrites the pathway on each one
    // immediately before serializing it, so nothing may come between the two.
    let pathwayOnlyCarrier
    const injectable = []
    let requestSize = 0

    for (let i = 0; i < entries.length && requestSize < MAX_PUT_EVENTS_BYTES; i++) {
      const entry = entries[i]
      const tracePropagated = traceCarrier !== undefined && (i === 0 || batchPropagationEnabled)
      let carrier = traceCarrier
      if (!tracePropagated) {
        if (dsmEnabled) pathwayOnlyCarrier ??= DsmPathwayCodec.encode(PATHWAY_SIZE_PROBE)
        carrier = pathwayOnlyCarrier
      }
      if (carrier !== undefined && typeof entry?.Detail === 'string') {
        // A malformed Detail is skipped rather than fatal: EventBridge partial-fails that entry,
        // so the rest of the batch still propagates.
        const traceOnlyDetail = injectDetail(entry.Detail, carrier)
        if (traceOnlyDetail !== undefined) {
          // The pathway field is a fixed width, so reserving it is exact and saves building the
          // detail a second time just to measure it.
          const reserved = dsmEnabled && tracePropagated ? PATHWAY_FIELD_BYTES : 0
          requestSize += putEventEntrySize(entry, traceOnlyDetail) + reserved
          injectable.push({
            entry,
            carrier,
            payloadSize: dsmEnabled ? dsmPayloadSize(entry) : 0,
            traceOnlyDetail: tracePropagated ? traceOnlyDetail : undefined,
          })
          continue
        }
      }
      requestSize += putEventEntrySize(entry)
    }

    if (injectable.length === 0) return
    if (requestSize >= MAX_PUT_EVENTS_BYTES) {
      log.info('Payload size too large to pass context')
      return
    }

    for (const { entry, carrier, payloadSize, traceOnlyDetail } of injectable) {
      let detail = traceOnlyDetail
      if (dsmEnabled) {
        const dataStreamsContext = this.setDSMCheckpoint(span, entry, payloadSize)
        // Anything short of a real pathway leaves the carrier on the sizing stand-in, which must
        // never ship; a pathway-only entry then has no fallback and keeps the caller's detail.
        if (DsmPathwayCodec.encode(dataStreamsContext, carrier) !== undefined) {
          detail = injectDetail(entry.Detail, carrier)
        }
      }
      if (detail !== undefined) entry.Detail = detail
    }
  }

  /**
   * Edge tags feed the pathway hash, so they are a cross-tracer contract: renaming or merging one
   * splits the DSM pathway instead of extending it.
   *
   * @param {import('../../../..').Span} span
   * @param {PutEventsRequestEntry} entry
   * @param {number} payloadSize `dsmPayloadSize(entry)`, taken before the `_datadog` context is
   *   injected. The trailing `0` opts out of the pathway estimate the processor adds by default,
   *   because that context is propagation overhead rather than the caller's payload.
   * @returns {object|undefined}
   */
  setDSMCheckpoint (span, entry, payloadSize) {
    const eventBus = entry.EventBusName || DEFAULT_EVENT_BUS
    const detailType = entry.DetailType ?? DEFAULT_DETAIL_TYPE
    return this.tracer.setCheckpoint(
      ['direction:out', `exchange:${eventBus}`, `topic:${detailType}`, 'type:eventbridge'],
      span,
      payloadSize,
      0,
    )
  }
}
module.exports = EventBridge
