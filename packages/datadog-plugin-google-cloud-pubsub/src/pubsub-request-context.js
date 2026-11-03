'use strict'

const SpanContext = require('../../dd-trace/src/opentracing/span_context')
const id = require('../../dd-trace/src/id')

/**
 * @param {Record<string, string>} attributes
 * @returns {import('../../dd-trace/src/opentracing/span_context') | null}
 */
function reconstructPubSubRequestContext (attributes) {
  const traceIdLower = attributes['_dd.pubsub_request.trace_id']
  const spanId = attributes['_dd.pubsub_request.span_id']
  const traceIdUpper = attributes['_dd.pubsub_request.p.tid']

  if (!traceIdLower || !spanId) return null

  const traceId128 = traceIdUpper ? traceIdUpper + traceIdLower : traceIdLower.padStart(32, '0')
  const traceId = id(traceId128, 16)
  const parentId = id(spanId, 16)

  const tags = {}
  if (traceIdUpper) tags['_dd.p.tid'] = traceIdUpper

  return new SpanContext({
    traceId,
    spanId: parentId,
    tags,
  })
}

module.exports = reconstructPubSubRequestContext
