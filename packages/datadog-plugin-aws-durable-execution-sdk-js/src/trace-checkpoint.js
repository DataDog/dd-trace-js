'use strict'

const crypto = require('crypto')
const log = require('../../dd-trace/src/log')
const TraceState = require('../../dd-trace/src/opentracing/propagation/tracestate')

const CHECKPOINT_NAME_PREFIX = '_datadog_'
const TERMINAL_STATUSES = new Set(['SUCCEEDED', 'FAILED'])

/**
 * Build the Datadog-format headers dict from a span context.
 * Mirrors ddtrace-py HTTPPropagator.inject output so the same payload
 * can be consumed by either language's datadog-lambda wrapper.
 * @param {object} spanContext
 * @returns {Record<string, string>}
 */
function injectHeaders(tracer, span) {
  const headers = {}
  try {
    tracer.inject(span, 'http_headers', headers)
  } catch (e) {
    log.debug('Failed to inject trace context', e)
  }
  return headers
}

/**
 * Extract the trace_id string from a headers dict.
 * Supports Datadog and W3C traceparent formats.
 * @param {Record<string, string>} headers
 * @returns {string | undefined}
 */
function headersTraceId(headers) {
  if (headers['x-datadog-trace-id']) return String(headers['x-datadog-trace-id'])
  const tp = headers.traceparent
  if (typeof tp === 'string') {
    const parts = tp.split('-')
    if (parts.length === 4) return parts[1]
  }
  return undefined
}

/**
 * Extract the parent_id string from a headers dict.
 * @param {Record<string, string>} headers
 * @returns {string | undefined}
 */
function headersParentId(headers) {
  if (headers['x-datadog-parent-id']) return String(headers['x-datadog-parent-id'])
  const tp = headers.traceparent
  if (typeof tp === 'string') {
    const parts = tp.split('-')
    if (parts.length === 4) return parts[2]
  }
  return undefined
}

/**
 * Return a normalized copy of headers with volatile parent-context fields removed.
 * Used for equality comparison while ignoring parent linkage differences that
 * are expected to change between invocations.
 * @param {Record<string, string>} headers
 * @returns {Record<string, string>}
 */
function normalizeAndIgnoreParentContextFields(headers) {
  const out = { ...headers }
  delete out['x-datadog-parent-id']
  const tp = out.traceparent
  if (typeof tp === 'string') {
    const parts = tp.split('-')
    if (parts.length === 4) {
      parts[2] = '0'.repeat(16)
      out.traceparent = parts.join('-')
    }
  }
  const ts = out.tracestate
  if (typeof ts === 'string') {
    try {
      const tracestate = TraceState.fromString(ts)
      tracestate.forVendor('dd', ddState => {
        // dd.p in tracestate is "last Datadog span id". It changes naturally
        // as active spans change and should not by itself trigger checkpoint churn.
        ddState.delete('p')
      })
      const normalized = tracestate.toString()
      if (normalized) {
        out.tracestate = normalized
      } else {
        delete out.tracestate
      }
    } catch {
      // Keep original tracestate if parsing fails; extraction handles invalid
      // values separately and we avoid changing behavior in that case.
    }
  }
  return out
}

/**
 * Mutate headers in-place to set parent_id to the provided value.
 * @param {Record<string, string>} headers
 * @param {string | number | undefined} parentId
 */
function overrideParentId(headers, parentId) {
  if (parentId === undefined || parentId === null) return
  if ('x-datadog-trace-id' in headers) {
    headers['x-datadog-parent-id'] = String(parentId)
  }
  // For W3C, parent_id is the third part of traceparent. We replace it with the new parentId but keep the original trace_id and flags to maintain the same trace linkage and sampling decision.
  const tp = headers.traceparent
  if (typeof tp === 'string') {
    const parts = tp.split('-')
    if (parts.length === 4) {
      let hex
      try {
        hex = BigInt(parentId).toString(16).padStart(16, '0')
      } catch {
        hex = String(parentId).padStart(16, '0').slice(0, 16)
      }
      parts[2] = hex
      headers.traceparent = parts.join('-')
    }
  }
}

/**
 * Shallow equality of two plain objects.
 * @param {Record<string, unknown>} a
 * @param {Record<string, unknown>} b
 * @returns {boolean}
 */
function shallowEqual(a, b) {
  const ak = Object.keys(a)
  const bk = Object.keys(b)
  if (ak.length !== bk.length) return false
  for (const k of ak) {
    if (a[k] !== b[k]) return false
  }
  return true
}

/**
 * Find the checkpoint with the highest N for _datadog_{N} in the event's operations.
 * @param {unknown} event
 * @returns {{ number: number, operation: object } | null}
 */
function findLastCheckpointOrNull(event) {
  if (!event || typeof event !== 'object') return null

  const operations = event.InitialExecutionState?.Operations
  if (!Array.isArray(operations)) return null

  let best = null
  for (const op of operations) {
    const name = op?.Name
    if (typeof name !== 'string') continue

    if (!name.startsWith(CHECKPOINT_NAME_PREFIX)) continue
    const suffix = name.slice(CHECKPOINT_NAME_PREFIX.length)
    const n = Number.parseInt(suffix, 10)
    if (Number.isNaN(n) || String(n) !== suffix) continue

    if (!best || n > best.number) {
      best = { number: n, operation: op }
    }
  }

  return best
}

/**
 * Parse the JSON payload from a checkpoint STEP operation's Payload or StepDetails.Result.
 * @param {object} op
 * @returns {Record<string, string> | null}
 */
function parseCheckpointPayload(op) {
  try {
    const raw = op?.Payload ?? op?.StepDetails?.Result
    if (!raw || typeof raw !== 'string') return null
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    log.debug('Failed to parse checkpoint payload')
    return null
  }
}

/**
 * Save a _datadog_{number} STEP operation via the SDK's checkpoint manager.
 * Uses a deterministic blake2b hash of (name:arn) as the stepId so the save is
 * idempotent within an execution.
 * @param {object} checkpointManager
 * @param {string} executionArn
 * @param {number} number
 * @param {Record<string, string>} headers
 * @returns {Promise<void>}
 */
async function saveCheckpoint(checkpointManager, executionArn, number, headers) {
  const name = `${CHECKPOINT_NAME_PREFIX}${number}`
  const stepId = crypto
    .createHash('blake2b512')
    .update(`${name}:${executionArn}`)
    .digest('hex')
    .slice(0, 64)
  const payload = JSON.stringify(headers)

  // Queue START and SUCCEED back-to-back before awaiting. This allows callers
  // to trigger save right before termination without losing the second update.
  const startPromise = checkpointManager.checkpoint(stepId, {
    Id: stepId,
    Action: 'START',
    Type: 'STEP',
    SubType: 'STEP',
    Name: name,
  })
  const succeedPromise = checkpointManager.checkpoint(stepId, {
    Id: stepId,
    Action: 'SUCCEED',
    Type: 'STEP',
    SubType: 'STEP',
    Name: name,
    Payload: payload,
  })
  await startPromise
  await succeedPromise
  log.debug(`Saved trace context checkpoint ${name}`)
}

/**
 * If conditions are met, save a new trace-context checkpoint.
 *   - Skips when result Status is SUCCEEDED/FAILED (terminal).
 *   - First checkpoint (no previous): uses number 0, parent_id = parentSpanId.
 *   - Subsequent: picks max number + 1, reuses previous checkpoint's parent_id,
 *     and saves only if trace context changed (ignoring parent_id).
 * @param {object} tracer
 * @param {object} span - aws.durable_execution.execute span
 * @param {object} durableContext - SDK's DurableContextImpl
 * @param {string | undefined} parentSpanId
 * @param {unknown} event - raw invocation event (has InitialExecutionState)
 * @param {unknown} result - user handler return value
 * @returns {Promise<void>}
 */
async function maybeSaveTraceContextCheckpoint(
  tracer, span, durableContext, parentSpanId, event, result,
) {
  try {
    if (!span || !durableContext) return
    const checkpointManager = durableContext.checkpoint ?? durableContext.checkpointManager
    if (!checkpointManager || typeof checkpointManager.checkpoint !== 'function') return

    // Skip if the manager is already terminating — its checkpoint() returns
    // a Promise that never resolves, which would hang Lambda until timeout.
    if (checkpointManager.isTerminating) {
      return
    }

    // Skip for terminal statuses — no next invocation
    if (result && typeof result === 'object' && TERMINAL_STATUSES.has(result.Status)) {
      return
    }

    const currentHeaders = injectHeaders(tracer, span)
    if (!currentHeaders || Object.keys(currentHeaders).length === 0) return

    const latest = findLastCheckpointOrNull(event)

    let newNumber
    if (!latest) {
      newNumber = 0
      if (parentSpanId) overrideParentId(currentHeaders, parentSpanId)
    } else {
      const latestHeaders = parseCheckpointPayload(latest.operation)
      if (!latestHeaders) return

      if (shallowEqual(
        normalizeAndIgnoreParentContextFields(currentHeaders),
        normalizeAndIgnoreParentContextFields(latestHeaders),
      )) {
        return
      }

      newNumber = latest.number + 1
      overrideParentId(currentHeaders, headersParentId(latestHeaders))
    }

    const executionArn = event?.DurableExecutionArn || ''
    await saveCheckpoint(checkpointManager, executionArn, newNumber, currentHeaders)
  } catch (e) {
    log.debug('Failed to save trace context checkpoint', e)
  }
}

module.exports = {
  CHECKPOINT_NAME_PREFIX,
  maybeSaveTraceContextCheckpoint,
}
