'use strict'

const api = require('@opentelemetry/api')
const {
  getSpanStartTimeMs,
  normalizeTraceId,
  resolveActiveSpanMeta,
} = require('./otel-orchestration-meta')

const httpParentByInstance = new Map()
const pendingHttpParentByTraceId = new Map()
const instanceStartByInstance = new Map()

function traceIdsEquivalent (left, right) {
  if (!left || !right) return false
  const a = normalizeTraceId(left)
  const b = normalizeTraceId(right)
  if (a === b) return true
  return a.slice(-16) === b.slice(-16)
}

function publishHttpParentMeta (instanceId, meta, instanceStartTime) {
  if (!instanceId || !meta?.traceId || !meta?.spanId) return

  const key = String(instanceId)
  const normalized = {
    traceId: normalizeTraceId(meta.traceId),
    spanId: meta.spanId,
  }

  httpParentByInstance.set(key, normalized)
  pendingHttpParentByTraceId.set(normalized.traceId, normalized)

  if (instanceStartTime != null) {
    recordHttpInstanceStartTime(instanceId, instanceStartTime)
  }

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

function recordHttpInstanceStartTime (instanceId, startTime) {
  if (!instanceId || startTime == null) return

  const key = String(instanceId)
  const current = instanceStartByInstance.get(key)
  if (current != null && current <= startTime) return

  instanceStartByInstance.set(key, startTime)

  const { mergeInstanceStartTime } = require('./otel-orchestration-store')
  mergeInstanceStartTime(instanceId, startTime)
}

function peekHttpInstanceStartTime (instanceId) {
  if (!instanceId) return
  return instanceStartByInstance.get(String(instanceId))
}

function clearHttpInstanceStartTime (instanceId) {
  if (!instanceId) return
  instanceStartByInstance.delete(String(instanceId))
}

function clearHttpOrchestrationLinks (instanceId) {
  if (!instanceId) return

  const key = String(instanceId)
  const parent = httpParentByInstance.get(key)
  httpParentByInstance.delete(key)
  instanceStartByInstance.delete(key)

  if (parent?.traceId) {
    pendingHttpParentByTraceId.delete(parent.traceId)
  }
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
      const spanMeta = resolveActiveSpanMeta(activeSpan)
      const instanceStartTime = getSpanStartTimeMs(activeSpan) ?? Date.now()

      if (spanMeta) {
        publishPendingHttpParent(spanMeta)
      }

      const instanceId = await startNew.apply(this, args)

      if (instanceId) {
        recordHttpInstanceStartTime(instanceId, instanceStartTime)

        if (spanMeta) {
          publishHttpParentMeta(instanceId, spanMeta, instanceStartTime)

          // The orchestration usually runs in another worker process, which cannot see
          // the in-process maps above, so persist its identity to the shared store now.
          const { seedOrchestrationMetaFromHttpParent } = require('./otel-orchestration-store')
          await seedOrchestrationMetaFromHttpParent(
            instanceId,
            spanMeta,
            typeof args[0] === 'string' ? args[0] : undefined,
            instanceStartTime,
          )
        }
      }

      return instanceId
    }
  })
}

module.exports = {
  applyHttpParentToMeta,
  clearHttpInstanceStartTime,
  clearHttpOrchestrationLinks,
  patchDurableClient,
  peekHttpInstanceStartTime,
  peekHttpParentForInstance,
  peekPendingHttpParent,
  publishHttpParentMeta,
  publishPendingHttpParent,
  recordHttpInstanceStartTime,
  resolveHttpParentForOrchestration,
  traceIdsEquivalent,
}
