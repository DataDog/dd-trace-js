'use strict'

const { DsmPathwayCodec } = require('./pathway')

// Same tag set as dd-trace-java's DataStreamsContext.forHttpClient/forHttpServer. Kept pre-sorted because
// computePathwayHash sorts edge tags in place.
const CLIENT_EDGE_TAGS = ['direction:out', 'type:http']
const SERVER_EDGE_TAGS = ['direction:in', 'type:http']

/**
 * Records an outbound HTTP checkpoint and writes its pathway context into `headers`.
 *
 * The returned context belongs on the request's own store: storing it on the caller's store would make sibling
 * requests chain from each other instead of from the caller's checkpoint.
 *
 * @param {import('../tracer')} tracer
 * @param {import('../opentracing/span')} span
 * @param {object | null | undefined} parentContext The caller's data streams context.
 * @param {Record<string, unknown>} headers Outgoing request headers.
 * @returns {object | undefined}
 */
function setHttpClientCheckpoint (tracer, span, parentContext, headers) {
  const ctx = tracer._dataStreamsProcessor.setCheckpoint(CLIENT_EDGE_TAGS, span, parentContext, 0, 0)
  DsmPathwayCodec.encode(ctx, headers)
  return ctx
}

/**
 * Records an inbound HTTP checkpoint, parented on the pathway context in the request headers if there is one.
 *
 * @param {import('../tracer')} tracer
 * @param {import('../opentracing/span')} span
 * @param {Record<string, unknown>} headers Incoming request headers, with lowercase names.
 * @returns {object | undefined}
 */
function setHttpServerCheckpoint (tracer, span, headers) {
  const parentContext = DsmPathwayCodec.decode(headers)
  return tracer._dataStreamsProcessor.setCheckpoint(SERVER_EDGE_TAGS, span, parentContext, 0, 0)
}

/**
 * dd-trace-java leaves requests sent by an AWS SDK out of HTTP propagation, and so without an HTTP checkpoint: they are
 * signed, and a messaging call records its own checkpoint. SDK v3 marks every request with `amz-sdk-invocation-id`, and
 * the aws-sdk plugin's span is the parent of v2 and v3 requests.
 *
 * @param {import('../opentracing/span') | null | undefined} parentSpan
 * @param {unknown} invocationId The request's `amz-sdk-invocation-id` header value.
 */
function isAwsSdkRequest (parentSpan, invocationId) {
  return invocationId !== undefined || parentSpan?._integrationName === 'aws-sdk'
}

module.exports = {
  isAwsSdkRequest,
  setHttpClientCheckpoint,
  setHttpServerCheckpoint,
}
