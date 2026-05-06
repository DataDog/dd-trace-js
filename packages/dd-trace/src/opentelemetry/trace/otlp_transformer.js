'use strict'

const OtlpTransformerBase = require('../otlp/otlp_transformer_base')
const { getProtobufTypes } = require('../otlp/protobuf_loader')
const { VERSION } = require('../../../../../version')
const id = require('../../id')

const { protoSpanKind } = getProtobufTypes()
const SPAN_KIND_UNSPECIFIED = protoSpanKind.values.SPAN_KIND_UNSPECIFIED
const SPAN_KIND_INTERNAL = protoSpanKind.values.SPAN_KIND_INTERNAL
const SPAN_KIND_SERVER = protoSpanKind.values.SPAN_KIND_SERVER
const SPAN_KIND_CLIENT = protoSpanKind.values.SPAN_KIND_CLIENT
const SPAN_KIND_PRODUCER = protoSpanKind.values.SPAN_KIND_PRODUCER
const SPAN_KIND_CONSUMER = protoSpanKind.values.SPAN_KIND_CONSUMER

// Cached zero Identifier used to detect zero IDs without re-allocating per span.
const ZERO_ID = id('0')

/**
 * @typedef {import('../../id').Identifier} Identifier
 *
 * @typedef {object} DDSpanLink
 * @property {string} trace_id - Hex-encoded trace ID
 * @property {string} span_id - Hex-encoded span ID
 * @property {Record<string, string | number | boolean>} [attributes] - Link attributes
 * @property {number} [flags] - Trace flags
 * @property {string} [tracestate] - W3C trace state
 *
 * @typedef {object} DDSpanEvent
 * @property {string} name - Event name
 * @property {number} time_unix_nano - Event time in nanoseconds since epoch
 * @property {Record<string, string | number | boolean>} [attributes] - Event attributes
 *
 * @typedef {object} DDFormattedSpan
 * @property {Identifier} trace_id - DD Identifier for trace ID
 * @property {Identifier} span_id - DD Identifier for span ID
 * @property {Identifier} parent_id - DD Identifier for parent span ID
 * @property {string} name - Span operation name
 * @property {string} resource - Resource name
 * @property {string} [service] - Service name
 * @property {string} [type] - Span type
 * @property {number} error - Error flag (0 or 1)
 * @property {{[key: string]: string}} meta - String key-value tags
 * @property {{[key: string]: number}} metrics - Numeric key-value tags
 * @property {{[key: string]: object}} [meta_struct] - Structured tags (JSON-serialized, bytes in protobuf)
 * @property {number} start - Start time in nanoseconds since epoch
 * @property {number} duration - Duration in nanoseconds
 * @property {DDSpanEvent[]} [span_events] - Span events
 */

// Map DD span.kind string values to OTLP SpanKind numeric values
const SPAN_KIND_MAP = {
  internal: SPAN_KIND_INTERNAL,
  server: SPAN_KIND_SERVER,
  client: SPAN_KIND_CLIENT,
  producer: SPAN_KIND_PRODUCER,
  consumer: SPAN_KIND_CONSUMER,
}

// OTLP StatusCode values (from trace.proto Status.StatusCode enum)
const STATUS_CODE_UNSET = 0
const STATUS_CODE_ERROR = 2

// DD meta keys that are mapped to dedicated OTLP span fields and should not appear as attributes
const EXCLUDED_META_KEYS = new Set([
  '_dd.span_links',
  'span.kind',
])

/**
 * OtlpTraceTransformer transforms DD-formatted spans to OTLP trace JSON format.
 *
 * This implementation follows the OTLP trace data model:
 * https://opentelemetry.io/docs/specs/otlp/#trace-data-model
 *
 * It receives DD-formatted spans (from span_format.js) and produces
 * an ExportTraceServiceRequest serialized as JSON (http/json protocol only).
 *
 * @class OtlpTraceTransformer
 * @augments OtlpTransformerBase
 */
class OtlpTraceTransformer extends OtlpTransformerBase {
  /**
   * Creates a new OtlpTraceTransformer instance.
   *
   * @param {import('@opentelemetry/api').Attributes} resourceAttributes - Resource attributes
   */
  constructor (resourceAttributes) {
    super(resourceAttributes, 'http/json', 'traces')
  }

  /**
   * Transforms DD-formatted spans to OTLP JSON format.
   *
   * @param {DDFormattedSpan[]} spans - Array of DD-formatted spans to transform
   * @returns {Buffer} JSON-encoded trace data
   */
  transformSpans (spans) {
    const traceData = {
      resourceSpans: [{
        resource: this.transformResource(),
        scopeSpans: this.#transformScopeSpans(spans),
      }],
    }
    return this.serializeToJson(traceData)
  }

  /**
   * Creates scope spans. DD spans do not carry instrumentation scope info,
   * so all spans are placed under a single default scope.
   *
   * @param {DDFormattedSpan[]} spans - Array of DD-formatted spans
   * @returns {object[]} Array of scope span objects
   */
  #transformScopeSpans (spans) {
    return [{
      scope: {
        name: 'dd-trace-js',
        version: VERSION,
        attributes: [],
        droppedAttributesCount: 0,
      },
      schemaUrl: '',
      spans: spans.map(span => this.#transformSpan(span)),
    }]
  }

  /**
   * Transforms a single DD-formatted span to an OTLP Span object.
   *
   * @param {DDFormattedSpan} span - DD-formatted span to transform
   * @returns {object} OTLP Span object
   */
  #transformSpan (span) {
    const parentId = span.parent_id
    const links = this.#extractLinks(span.meta?.['_dd.span_links'])

    return {
      traceId: this.#idToBytes(span.trace_id, 16),
      spanId: this.#idToBytes(span.span_id, 8),
      parentSpanId: (parentId && !parentId.equals(ZERO_ID)) ? this.#idToBytes(parentId, 8) : undefined,
      name: span.resource,
      kind: this.#mapSpanKind(span.meta?.['span.kind']),
      startTimeUnixNano: span.start,
      endTimeUnixNano: span.start + span.duration,
      attributes: this.#buildAttributes(span),
      droppedAttributesCount: 0,
      events: span.span_events?.length ? span.span_events.map(event => this.#transformEvent(event)) : undefined,
      droppedEventsCount: 0,
      links: links.length ? links : undefined,
      droppedLinksCount: 0,
      status: this.#mapStatus(span),
    }
  }

  /**
   * Builds OTLP attributes from DD span fields.
   * Merges top-level DD fields (service, resource, type), meta (string tags),
   * and metrics (numeric tags) into a single OTLP KeyValue array.
   *
   * @param {DDFormattedSpan} span - DD-formatted span
   * @returns {object[]} Array of OTLP KeyValue objects
   */
  #buildAttributes (span) {
    const attributes = []

    // Add top-level DD span fields as OTLP attributes
    if (span.service) {
      attributes.push({ key: 'service.name', value: { stringValue: span.service } })
    }
    if (span.name) {
      attributes.push({ key: 'operation.name', value: { stringValue: span.name } })
    }
    if (span.resource) {
      attributes.push({ key: 'resource.name', value: { stringValue: span.resource } })
    }
    if (span.type) {
      attributes.push({ key: 'span.type', value: { stringValue: span.type } })
    }

    // Add meta string tags, skipping keys that map to dedicated OTLP fields
    if (span.meta) {
      for (const [key, value] of Object.entries(span.meta)) {
        if (EXCLUDED_META_KEYS.has(key)) continue
        attributes.push({ key, value: { stringValue: value } })
      }
    }

    // Add metrics as numeric attributes
    if (span.metrics) {
      for (const [key, value] of Object.entries(span.metrics)) {
        if (Number.isInteger(value)) {
          attributes.push({ key, value: { intValue: value } })
        } else {
          attributes.push({ key, value: { doubleValue: value } })
        }
      }
    }

    // TODO: meta_struct values are logically raw bytes. The OTLP http/json spec encodes the bytesValue
    // field as base64, but when http/protobuf or gRPC support is added the payload should be sent as
    // raw bytes directly (no JSON.stringify + base64). The backend decoding side will need to be
    // updated in parallel to accept the unencoded bytes.
    if (span.meta_struct) {
      for (const [key, value] of Object.entries(span.meta_struct)) {
        const bytes = Buffer.from(JSON.stringify(value))
        attributes.push({ key, value: { bytesValue: bytes.toString('base64') } })
      }
    }

    return attributes
  }

  /**
   * Maps a DD span.kind string to an OTLP SpanKind enum value.
   *
   * @param {string | undefined} kind - DD span kind string
   * @returns {number} OTLP SpanKind enum value
   */
  #mapSpanKind (kind) {
    if (!kind) return SPAN_KIND_UNSPECIFIED
    return SPAN_KIND_MAP[kind] ?? SPAN_KIND_UNSPECIFIED
  }

  /**
   * Maps DD span error state to an OTLP Status object.
   * Combines error.type and error.message when both are present so error type
   * information is preserved on the OTel side.
   *
   * @param {DDFormattedSpan} span - DD-formatted span
   * @returns {object} OTLP Status object with code and message
   */
  #mapStatus (span) {
    if (span.error !== 1) {
      return { code: STATUS_CODE_UNSET, message: '' }
    }
    const errorType = span.meta?.['error.type']
    const errorMessage = span.meta?.['error.message']
    let message = ''
    if (errorType && errorMessage) {
      message = `${errorType}: ${errorMessage}`
    } else if (errorType) {
      message = errorType
    } else if (errorMessage) {
      message = errorMessage
    }
    return { code: STATUS_CODE_ERROR, message }
  }

  /**
   * Transforms a DD span event to an OTLP Event object.
   *
   * @param {DDSpanEvent} event - DD span event
   * @returns {object} OTLP Event object
   */
  #transformEvent (event) {
    return {
      timeUnixNano: event.time_unix_nano,
      name: event.name || '',
      attributes: this.transformAttributes(event.attributes ?? {}),
      droppedAttributesCount: 0,
    }
  }

  /**
   * Extracts and transforms span links from the DD _dd.span_links meta JSON string.
   *
   * @param {string | undefined} spanLinksJson - JSON-encoded array of DD span links
   * @returns {object[]} Array of OTLP Link objects
   */
  #extractLinks (spanLinksJson) {
    if (!spanLinksJson) return []

    let parsedLinks
    try {
      parsedLinks = JSON.parse(spanLinksJson)
    } catch {
      return []
    }

    if (!Array.isArray(parsedLinks)) return []

    return parsedLinks.map(link => this.#transformLink(link))
  }

  /**
   * Transforms a single DD span link to an OTLP Link object.
   *
   * @param {DDSpanLink} link - DD span link
   * @returns {object} OTLP Link object
   */
  #transformLink (link) {
    return {
      traceId: this.#hexToBytes(link.trace_id, 16),
      spanId: this.#hexToBytes(link.span_id, 8),
      traceState: link.tracestate || '',
      attributes: this.transformAttributes(link.attributes ?? {}),
      droppedAttributesCount: 0,
      flags: link.flags,
    }
  }

  /**
   * Converts a DD Identifier object to a hex-encoded string of the specified byte length.
   * Pads with leading zeros if the identifier buffer is shorter than the target.
   * Per the OTLP http/json spec, trace-ids and span-ids must be hex-encoded strings.
   *
   * @param {Identifier} identifier - DD Identifier
   * @param {number} targetLength - Target byte length (16 for trace ID, 8 for span ID)
   * @returns {string} Hex-encoded string of the specified length
   */
  #idToBytes (identifier, targetLength) {
    const buffer = identifier.toBuffer()
    if (buffer.length === targetLength) {
      return Buffer.from(buffer).toString('hex')
    }
    if (buffer.length > targetLength) {
      return Buffer.from(buffer.slice(buffer.length - targetLength)).toString('hex')
    }
    // Pad with leading zeros to reach target length.
    const result = Buffer.alloc(targetLength)
    Buffer.from(buffer).copy(result, targetLength - buffer.length)
    return result.toString('hex')
  }

  /**
   * Normalizes a hex string to the specified byte length.
   * Pads with leading zeros if the hex string is shorter than expected.
   * Per the OTLP http/json spec, trace-ids and span-ids must be hex-encoded strings.
   *
   * @param {string | undefined} hexString - Hex string to normalize
   * @param {number} targetLength - Target byte length
   * @returns {string} Hex-encoded string of the specified length
   */
  #hexToBytes (hexString, targetLength) {
    if (!hexString) return '0'.repeat(targetLength * 2)
    const cleanHex = hexString.startsWith('0x') ? hexString.slice(2) : hexString
    return cleanHex.padStart(targetLength * 2, '0')
  }
}

module.exports = OtlpTraceTransformer
