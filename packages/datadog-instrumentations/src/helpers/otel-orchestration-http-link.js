'use strict'

const api = require('@opentelemetry/api')
const { getSpanMeta, normalizeTraceId } = require('./otel-orchestration-meta')

const httpParentByInstance = new Map()
const pendingHttpParentByTraceId = new Map()

function traceIdsEquivalent (left, right) {
  if (!left || !right) return false
  const a = normalizeTraceId(left)
  const b = normalizeTraceId(right)
  if (a === b) return true
  return a.slice(-16) === b.slice(-16)
}

function publishHttpParentMeta (instanceId, meta) {
  if (!instanceId || !meta?.traceId || !meta?.spanId) return

  const key = String(instanceId)
  const normalized = {
    traceId: normalizeTraceId(meta.traceId),
    spanId: meta.spanId,
  }

  httpParentByInstance.set(key, normalized)
  pendingHttpParentByTraceId.set(normalized.traceId, normalized)

  const { reconcileOrchestrationHttpParent } = require('./otel-orchestration-store')
  reconcileOrchestrationHttpParent(key, normalized)
}

function publishPendingHttpParent (meta) {
  if (!meta?.traceId || !meta?.spanId) return

  const normalized = {
    traceId: normalizeTraceId(meta.traceId),
    spanId: meta.spanId,
  }
  pendingHttpParentByTraceId.set(normalized.traceId, normalized)
}

function peekHttpParentForInstance (instanceId) {
  if (!instanceId) return
  return httpParentByInstance.get(String(instanceId))
}

function peekPendingHttpParent (traceId) {
  if (!traceId) return

  const normalized = normalizeTraceId(traceId)
  const direct = pendingHttpParentByTraceId.get(normalized)
  if (direct) return direct

  for (const [key, meta] of pendingHttpParentByTraceId) {
    if (traceIdsEquivalent(key, normalized)) {
      return meta
    }
  }
}

function resolveHttpParentForOrchestration (instanceId, traceContext) {
  const fromInstance = peekHttpParentForInstance(instanceId)
  if (fromInstance) return fromInstance

  const traceParent = traceContext?.traceParent
  if (!traceParent) return

  const traceId = traceParent.split('-')[1]
  return peekPendingHttpParent(traceId)
}

function applyHttpParentToMeta (meta, httpParent) {
  if (!meta || !httpParent?.spanId) return meta

  return {
    ...meta,
    traceId: httpParent.traceId ?? meta.traceId,
    parentId: httpParent.spanId,
    httpParentSpanId: httpParent.spanId,
  }
}

// The class must be handed in by the module hook: requiring `durable-functions`
// from inside the tracer would resolve against the tracer's own dependencies,
// not the application's copy, so the patch would target the wrong class.
function patchDurableClient (DurableClient) {
  const shimmer = require('../../../datadog-shimmer')
  if (typeof DurableClient?.prototype?.startNew !== 'function') return

  shimmer.wrap(DurableClient.prototype, 'startNew', startNew => {
    return async function (...args) {
      const activeSpan = api.trace.getActiveSpan()
      const spanMeta = activeSpan ? getSpanMeta(activeSpan) : undefined

      if (spanMeta) {
        publishPendingHttpParent(spanMeta)
      }

      const instanceId = await startNew.apply(this, args)

      if (instanceId && spanMeta) {
        publishHttpParentMeta(instanceId, spanMeta)

        // The orchestration usually runs in another worker process, which cannot see
        // the in-process maps above, so persist its identity to the shared store now.
        const { seedOrchestrationMetaFromHttpParent } = require('./otel-orchestration-store')
        seedOrchestrationMetaFromHttpParent(
          instanceId,
          spanMeta,
          typeof args[0] === 'string' ? args[0] : undefined,
          Date.now(),
        )
      }

      return instanceId
    }
  })
}

module.exports = {
  applyHttpParentToMeta,
  patchDurableClient,
  peekHttpParentForInstance,
  peekPendingHttpParent,
  publishHttpParentMeta,
  publishPendingHttpParent,
  resolveHttpParentForOrchestration,
  traceIdsEquivalent,
}
