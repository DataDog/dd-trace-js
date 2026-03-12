'use strict'

// Shared state between graphql sub-plugins.
// Deferred resolve spans keyed by execute span, finished together in asyncEnd.
const pendingResolveSpans = new WeakMap()

function registerPendingResolveSpan (executeSpan, resolveSpan, finishTime) {
  if (!executeSpan) return
  let pending = pendingResolveSpans.get(executeSpan)
  if (!pending) {
    pending = []
    pendingResolveSpans.set(executeSpan, pending)
  }
  pending.push({ span: resolveSpan, finishTime })
}

function finishAllPendingResolveSpans (executeSpan) {
  if (!executeSpan) return
  const pending = pendingResolveSpans.get(executeSpan)
  if (!pending) return
  for (const { span, finishTime } of pending) {
    // Finish resolve spans without triggering individual process() calls.
    // With partial flush (flushMinSpans >= 1), calling span.finish() on each resolve
    // span triggers a partial flush that exports it separately from the execute span.
    // Instead, we replicate the finish logic (set duration, tags, add to finished list)
    // but skip process(). The execute span's finish() will trigger process() once,
    // seeing all spans as finished and exporting them together in one trace payload.
    if (span._duration !== undefined) continue
    span._spanContext._tags['_dd.integration'] = span._integrationName
    const resolvedFinishTime = Number.parseFloat(finishTime) || span._getTime()
    span._duration = resolvedFinishTime - span._startTime
    span._spanContext._trace.finished.push(span)
    span._spanContext._isFinished = true
  }
  pendingResolveSpans.delete(executeSpan)
}

// Parse and validate spans that need to be deferred until execute finishes.
// Keyed by document AST object (WeakMap for auto GC).
const pendingParseValidateSpans = new WeakMap()

function registerPendingSpan (key, span) {
  if (!key) return
  let pending = pendingParseValidateSpans.get(key)
  if (!pending) {
    pending = []
    pendingParseValidateSpans.set(key, pending)
  }
  pending.push(span)
}

function finishAllPendingSpans (key) {
  if (!key) return
  const pending = pendingParseValidateSpans.get(key)
  if (!pending) return
  for (const span of pending) {
    span.finish()
  }
  pendingParseValidateSpans.delete(key)
}

module.exports = {
  registerPendingResolveSpan,
  finishAllPendingResolveSpans,
  registerPendingSpan,
  finishAllPendingSpans,
}
