'use strict'

const { getProtobufTypes } = require('../../packages/dd-trace/src/opentelemetry/otlp/protobuf_loader')

const { protoTraceService } = getProtobufTypes()

/**
 * Decodes an http/protobuf OTLP trace request into the shape the tracer sends over http/json, so test
 * agents hand assertions the same payload for both protocols: trace and span IDs as hex strings, other
 * bytes as base64, and 64-bit integers as numbers. Fields holding their proto3 default value are absent,
 * as they are on the protobuf wire.
 *
 * @param {Uint8Array} body - Encoded ExportTraceServiceRequest
 * @returns {object}
 */
function decodeOtlpTraceRequest (body) {
  const request = protoTraceService.toObject(protoTraceService.decode(body), {
    longs: Number,
    bytes: String,
    arrays: true,
  })
  for (const { scopeSpans } of request.resourceSpans) {
    for (const { spans } of scopeSpans) {
      for (const span of spans) {
        span.traceId = base64ToHex(span.traceId)
        span.spanId = base64ToHex(span.spanId)
        if (span.parentSpanId) span.parentSpanId = base64ToHex(span.parentSpanId)
        for (const link of span.links) {
          link.traceId = base64ToHex(link.traceId)
          link.spanId = base64ToHex(link.spanId)
        }
      }
    }
  }
  return request
}

/** @param {string} base64 */
function base64ToHex (base64) {
  return Buffer.from(base64, 'base64').toString('hex')
}

module.exports = { decodeOtlpTraceRequest }
