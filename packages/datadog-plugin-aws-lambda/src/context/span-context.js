'use strict'

const { AUTO_KEEP } = require('../../../../ext/priority')
const id = require('../../../dd-trace/src/id')
const SpanContext = require('../../../dd-trace/src/opentracing/span_context')

/**
 * Converts the shim's custom context contract to the core tracer's context.
 * Numeric sampling follows datadog-lambda-js #850 (13e2f4ca).
 *
 * @param {import('../../../../index').plugins.LambdaTraceContext} context Custom extractor result.
 * @returns {SpanContext|null}
 */
function fromTraceContext (context) {
  const traceId = context.traceId || context.traceID
  const spanId = context.parentId || context.parentID
  if (traceId === undefined || spanId === undefined) return null

  return new SpanContext({
    traceId: id(traceId, 10),
    spanId: id(spanId, 10),
    sampling: { priority: context.sampleMode },
  })
}

module.exports = { fromTraceContext, AUTO_KEEP }
