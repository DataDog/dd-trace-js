'use strict'

const TRACE_FLAGS_SAMPLED = '01'
const TRACESTATE_ORCH_PREFIX = 'dd=o:'

function normalizeTraceId (traceId) {
  if (!traceId) return
  if (typeof traceId === 'string' && /^[0-9a-f]+$/i.test(traceId)) {
    return traceId.padStart(32, '0').slice(-32)
  }
  const hex = traceId.toString(16).padStart(32, '0')
  return hex.length > 32 ? hex.slice(-32) : hex
}

function normalizeSpanId (spanId) {
  if (!spanId) return
  if (typeof spanId === 'string' && /^[0-9a-f]+$/i.test(spanId)) {
    return spanId.padStart(16, '0').slice(-16)
  }
  const hex = spanId.toString(16).padStart(16, '0')
  return hex.length > 16 ? hex.slice(-16) : hex
}

function getSpanMeta (span) {
  if (!span) return

  const ddSpan = span._ddSpan
  if (ddSpan?.context) {
    const ctx = ddSpan.context()
    return {
      traceId: normalizeTraceId(ctx._traceId),
      spanId: normalizeSpanId(ctx._spanId),
    }
  }

  const spanContext = span.spanContext?.()
  if (spanContext?.traceId && spanContext.spanId) {
    return {
      traceId: normalizeTraceId(spanContext.traceId),
      spanId: normalizeSpanId(spanContext.spanId),
    }
  }
}

function getSpanStartTimeMs (span) {
  const ddSpan = span?._ddSpan
  if (ddSpan?._startTime != null) {
    return ddSpan._startTime
  }

  const hrStartTime = span?.startTime
  if (Array.isArray(hrStartTime)) {
    const { hrTimeToMilliseconds } = require('../../../dd-trace/src/opentelemetry/time')
    return hrTimeToMilliseconds(hrStartTime)
  }
}

function resolveActiveSpanMeta (span) {
  return getSpanMeta(span)
}

function parseOrchestrationMetaFromTraceContext (traceContext) {
  const traceState = traceContext?.traceState
  if (!traceState || typeof traceState !== 'string') return

  const orchEntry = traceState
    .split(',')
    .map(entry => entry.trim())
    .find(entry => entry.startsWith(TRACESTATE_ORCH_PREFIX))

  if (!orchEntry) return

  const spanId = orchEntry.slice(TRACESTATE_ORCH_PREFIX.length)
  const traceParent = traceContext?.traceParent
  if (!spanId || !traceParent) return

  const parts = traceParent.split('-')
  if (parts.length < 4) return

  return {
    traceId: parts[1],
    spanId,
  }
}

function appendOrchestrationSpanToTraceState (traceState, spanId) {
  const entry = `${TRACESTATE_ORCH_PREFIX}${spanId}`
  if (!traceState) return entry
  if (traceState.includes(TRACESTATE_ORCH_PREFIX)) return traceState
  return `${traceState},${entry}`
}

function traceContextFromMeta (meta) {
  if (!meta?.traceId || !meta?.spanId) return

  return {
    traceParent: `00-${meta.traceId}-${meta.spanId}-${TRACE_FLAGS_SAMPLED}`,
  }
}

module.exports = {
  appendOrchestrationSpanToTraceState,
  getSpanMeta,
  getSpanStartTimeMs,
  normalizeSpanId,
  normalizeTraceId,
  parseOrchestrationMetaFromTraceContext,
  resolveActiveSpanMeta,
  traceContextFromMeta,
}
