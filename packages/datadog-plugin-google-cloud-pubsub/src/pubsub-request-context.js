'use strict'

const SpanContext = require('../../dd-trace/src/opentracing/span_context')
const id = require('../../dd-trace/src/id')

/**
 * @param {Record<string, string>} attributes
 * @param {SpanContext | null} originalContext
 * @param {import('../../dd-trace/src/config/config-base')['DD_TRACE_PROPAGATION_BEHAVIOR_EXTRACT']} propagationBehavior
 * @returns {import('../../dd-trace/src/opentracing/span_context') | null}
 */
function reconstructPubSubRequestContext (attributes, originalContext, propagationBehavior) {
  const traceIdLower = attributes['_dd.pubsub_request.trace_id']
  const spanId = attributes['_dd.pubsub_request.span_id']
  const traceIdUpper = attributes['_dd.pubsub_request.p.tid']

  if (!traceIdLower || !spanId) return null

  const traceId128 = traceIdUpper ? traceIdUpper + traceIdLower : traceIdLower.padStart(32, '0')
  const parentId = id(spanId, 16)

  if (originalContext?.toTraceId(true) === traceId128) {
    if (propagationBehavior !== 'restart') {
      originalContext._spanId = parentId
      return originalContext
    }

    // Restart links reference the extracted context, so preserve its original span ID.
    return new SpanContext({
      traceId: originalContext._traceId,
      spanId: parentId,
      isRemote: originalContext._isRemote,
      sampling: originalContext._sampling,
      baggageItems: originalContext._baggageItems,
      trace: originalContext._trace,
      traceparent: originalContext._traceparent,
      tracestate: originalContext._tracestate,
      links: originalContext._links,
    })
  }

  const tags = {}
  if (traceIdUpper) tags['_dd.p.tid'] = traceIdUpper

  return new SpanContext({
    traceId: id(traceId128, 16),
    spanId: parentId,
    trace: { started: [], finished: [], tags },
  })
}

module.exports = reconstructPubSubRequestContext
