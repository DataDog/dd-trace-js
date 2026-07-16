'use strict'
const log = require('../../../dd-trace/src/log')
const BaseAwsSdkPlugin = require('../base')

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
   * Max PutEvents request size is 1mb, summed over all entries
   * (https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-putevent-size.html)
   */
  requestInject (span, request) {
    const operation = request.operation
    if (operation === 'putEvents' &&
      request.params &&
      request.params.Entries &&
      request.params.Entries.length > 0 &&
      request.params.Entries[0].Detail) {
      const entries = request.params.Entries
      const injected = {}
      this.tracer.inject(span, 'text_map', injected)

      // Only `injectFieldIntoJsonObject` can throw (the slow path
      // `JSON.parse` for non-`{...}` payloads). Tighten the catch around
      // it so the rest of the body stays in V8's optimisable surface.
      let finalData
      try {
        finalData = BaseAwsSdkPlugin.injectFieldIntoJsonObject(entries[0].Detail, '_datadog', injected)
      } catch (error) {
        log.error('EventBridge error injecting request', error)
        return
      }

      // EventBridge applies the 1 MiB cap to the whole request, so size every
      // entry as it would be sent (the first with `_datadog` injected) and skip
      // rather than tip a request AWS would otherwise accept over the limit. The
      // running total only needs to clear the cap, so stop summing the moment it
      // does instead of byte-counting the rest of a batch we already know is over.
      let requestSize = putEventEntrySize(entries[0], finalData)
      for (let i = 1; requestSize < MAX_PUT_EVENTS_BYTES && i < entries.length; i++) {
        requestSize += putEventEntrySize(entries[i])
      }
      if (requestSize >= MAX_PUT_EVENTS_BYTES) {
        log.info('Payload size too large to pass context')
        return
      }
      entries[0].Detail = finalData
    }
  }
}
module.exports = EventBridge
