'use strict'

const api = require('@opentelemetry/api')
const createId = require('../../../dd-trace/src/id')
const DatadogSpanContext = require('../../../dd-trace/src/opentracing/span_context')
const OtelSpan = require('../../../dd-trace/src/opentelemetry/span')
const OtelSpanContext = require('../../../dd-trace/src/opentelemetry/span_context')
const { extractContext } = require('./azure-trace-context')
const { getTracer, spanAttributes, endSpan } = require('./otel-azure-span')
const { normalizeSpanId, normalizeTraceId } = require('./otel-orchestration-meta')
const { resolveHttpParentForOrchestration } = require('./otel-orchestration-http-link')

function getParentFromTraceContext (traceContext) {
  const traceParent = traceContext?.traceParent
  if (!traceParent) return

  const parts = traceParent.split('-')
  if (parts.length < 4) return

  return {
    traceId: normalizeTraceId(parts[1]),
    parentId: normalizeSpanId(parts[2]),
  }
}

function createOrchestrationMeta (instanceId, invocationContext, functionName) {
  const traceContext = invocationContext?.traceContext
  const httpParent = resolveHttpParentForOrchestration(instanceId, traceContext)
  const fromHeader = getParentFromTraceContext(traceContext)

  let traceId = httpParent?.traceId ?? fromHeader?.traceId
  let parentId = httpParent?.spanId ?? fromHeader?.parentId

  if (!traceId) {
    const parentContext = extractContext(traceContext)
    const parentSpan = api.trace.getSpan(parentContext)
    const parentDdContext = parentSpan?.spanContext()?._ddContext

    if (parentDdContext) {
      traceId = normalizeTraceId(parentDdContext._traceId)
      parentId ??= normalizeSpanId(parentDdContext._spanId)
    }
  }

  if (!traceId) {
    traceId = normalizeTraceId(createId())
  }

  return {
    instanceId,
    functionName,
    traceId,
    spanId: normalizeSpanId(createId()),
    parentId,
    startTime: Date.now(),
    status: 'open',
  }
}

// Build orchestration metadata from the HTTP span that called `startNew`. The
// orchestration runs later, often in another worker process, so its identity has
// to be decided here while the HTTP span is still known.
function createOrchestrationMetaFromHttpParent (instanceId, httpParent, functionName) {
  if (!httpParent?.traceId || !httpParent.spanId) return

  return {
    instanceId,
    functionName,
    traceId: normalizeTraceId(httpParent.traceId),
    spanId: normalizeSpanId(createId()),
    parentId: normalizeSpanId(httpParent.spanId),
    httpParentSpanId: normalizeSpanId(httpParent.spanId),
    startTime: Date.now(),
    // Replaced with the real start time on the first orchestration turn.
    pendingStart: true,
    status: 'open',
  }
}

function exportOrchestrationSpanFromMeta (tracerName, meta, { error, endTime } = {}) {
  if (!meta?.traceId || !meta?.spanId) return false

  const tracer = getTracer(tracerName)
  const ddContext = new DatadogSpanContext({
    traceId: createId(meta.traceId, 16),
    spanId: createId(meta.spanId, 16),
    parentId: meta.parentId ? createId(meta.parentId, 16) : null,
  })

  const span = new OtelSpan(
    tracer,
    api.ROOT_CONTEXT,
    `orchestration ${meta.functionName || 'orchestration'}`,
    new OtelSpanContext(ddContext),
    api.SpanKind.INTERNAL,
    [],
    meta.startTime,
    spanAttributes(meta.functionName || 'orchestration', 'durable-orchestration'),
  )

  if (error) {
    endSpan(span, error)
  } else {
    span.end(endTime ?? Date.now())
  }

  return true
}

module.exports = {
  createOrchestrationMeta,
  createOrchestrationMetaFromHttpParent,
  exportOrchestrationSpanFromMeta,
  getParentFromTraceContext,
}
