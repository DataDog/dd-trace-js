'use strict'

const TRACE_FLAGS_SAMPLED = '01'
const TRACESTATE_ORCH_PREFIX = 'dd=o:'

function normalizeTraceId (traceId) {
  if (!traceId) return undefined
  if (typeof traceId === 'string' && /^[0-9a-f]+$/i.test(traceId)) {
    return traceId.padStart(32, '0').slice(-32)
  }
  const hex = traceId.toString(16).padStart(32, '0')
  return hex.length > 32 ? hex.slice(-32) : hex
}

function normalizeSpanId (spanId) {
  if (!spanId) return undefined
  if (typeof spanId === 'string' && /^[0-9a-f]+$/i.test(spanId)) {
    return spanId.padStart(16, '0').slice(-16)
  }
  const hex = spanId.toString(16).padStart(16, '0')
  return hex.length > 16 ? hex.slice(-16) : hex
}

function getSpanMeta (span) {
  if (!span) return undefined

  const ddSpan = span._ddSpan
  if (ddSpan?.context) {
    const ctx = ddSpan.context()
    return {
      traceId: normalizeTraceId(ctx._traceId ?? ctx.toTraceId?.()),
      spanId: normalizeSpanId(ctx._spanId ?? ctx.toSpanId?.()),
    }
  }

  const spanContext = span.spanContext?.()
  if (spanContext?.traceId && spanContext?.spanId) {
    return {
      traceId: normalizeTraceId(spanContext.traceId),
      spanId: normalizeSpanId(spanContext.spanId),
    }
  }
}

function parseOrchestrationMetaFromTraceContext (traceContext) {
  const traceState = traceContext?.traceState
  if (!traceState || typeof traceState !== 'string') return undefined

  const orchEntry = traceState
    .split(',')
    .map(entry => entry.trim())
    .find(entry => entry.startsWith(TRACESTATE_ORCH_PREFIX))

  if (!orchEntry) return undefined

  const spanId = orchEntry.slice(TRACESTATE_ORCH_PREFIX.length)
  const traceParent = traceContext?.traceParent
  if (!spanId || !traceParent) return undefined

  const parts = traceParent.split('-')
  if (parts.length < 4) return undefined

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
  if (!meta?.traceId || !meta?.spanId) return undefined

  return {
    traceParent: `00-${meta.traceId}-${meta.spanId}-${TRACE_FLAGS_SAMPLED}`,
  }
}

module.exports = {
  appendOrchestrationSpanToTraceState,
  getSpanMeta,
  parseOrchestrationMetaFromTraceContext,
  traceContextFromMeta,
}
