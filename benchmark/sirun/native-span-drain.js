'use strict'

const DEFAULT_DRAIN_THRESHOLD = 5000

function createNativeSpanDrain (tracer, threshold = DEFAULT_DRAIN_THRESHOLD) {
  const nativeSpans = tracer._tracer._nativeSpans
  const pendingSpanIds = nativeSpans ? [] : null

  function add (span) {
    if (pendingSpanIds) {
      pendingSpanIds.push(span.context()._nativeSpanId)
    }
  }

  function addAll (spans) {
    if (!pendingSpanIds) return

    for (const span of spans) {
      pendingSpanIds.push(span.context()._nativeSpanId)
    }
  }

  async function drain () {
    if (!pendingSpanIds || pendingSpanIds.length === 0) return

    nativeSpans.flushChangeQueue()

    const spanIds = Buffer.allocUnsafe(pendingSpanIds.length * 8)
    let offset = 0
    for (const spanId of pendingSpanIds) {
      spanIds.set(spanId, offset)
      offset += 8
    }

    nativeSpans._state.prepareChunk(pendingSpanIds.length, false, spanIds)
    await nativeSpans._state.sendPreparedChunk().catch(() => {})
    pendingSpanIds.length = 0
  }

  function needsDrain () {
    return pendingSpanIds && pendingSpanIds.length >= threshold
  }

  return { add, addAll, drain, needsDrain }
}

module.exports = { createNativeSpanDrain }
