'use strict'

const crypto = require('crypto')
const log = require('../../dd-trace/src/log')
const TextMapPropagator = require('../../dd-trace/src/opentracing/propagation/text_map')

const CHECKPOINT_NAME_PREFIX = '_datadog_'

// Per-tracer-config cache for a propagator that injects only Datadog-style
// headers (`x-datadog-*`) regardless of the user's `DD_TRACE_PROPAGATION_STYLE_INJECT`.
// Checkpoints are written and read entirely by Datadog code, so honoring user
// style preferences would only complicate the payload contract.
const datadogOnlyPropagatorCache = new WeakMap()

function getDatadogOnlyPropagator (tracer) {
  const config = tracer?._tracer?._config ?? tracer?._config
  if (!config) return null
  const cached = datadogOnlyPropagatorCache.get(config)
  if (cached) return cached
  // Shadow `tracePropagationStyle.inject` while inheriting every other field
  // (baggage limits, x-datadog-tags length cap, etc.) from the live config.
  const shadowConfig = Object.create(config)
  shadowConfig.tracePropagationStyle = {
    ...config.tracePropagationStyle,
    inject: ['datadog'],
  }
  const propagator = new TextMapPropagator(shadowConfig)
  datadogOnlyPropagatorCache.set(config, propagator)
  return propagator
}

/**
 * Build the Datadog-format headers dict from a span context.
 * Mirrors ddtrace-py HTTPPropagator.inject output so the same payload
 * can be consumed by either language's datadog-lambda wrapper.
 * @param {object} tracer
 * @param {object} span
 * @returns {Record<string, string>}
 */
function injectHeaders (tracer, span) {
  const headers = {}
  try {
    const propagator = getDatadogOnlyPropagator(tracer)
    if (propagator) {
      const ctx = typeof span?.context === 'function' ? span.context() : span
      propagator.inject(ctx, headers)
    } else {
      // Test environments pass a tracer mock without `_config`. Fall back to
      // its own `inject` so unit tests can assert on the shape they control.
      tracer.inject?.(span, 'http_headers', headers)
    }
  } catch (e) {
    log.debug('Failed to inject trace context', e)
  }
  return headers
}

/**
 * Mutate headers in-place to set parent_id to the provided value.
 * @param {Record<string, string>} headers
 * @param {string | number | undefined} parentId
 */
function overrideParentId (headers, parentId) {
  if (parentId === undefined || parentId === null) return
  if ('x-datadog-trace-id' in headers) {
    headers['x-datadog-parent-id'] = String(parentId)
  }
}

/**
 * Find the checkpoint with the highest N for _datadog_{N} in the event's operations.
 * @param {unknown} event
 * @returns {{ number: number, operation: object } | null}
 */
function findLastCheckpointOrNull (event) {
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
function parseCheckpointPayload (op) {
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
async function saveCheckpoint (checkpointManager, executionArn, number, headers) {
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
  log.debug('Saved trace context checkpoint %s', name)
}

/**
 * Save a new trace-context checkpoint when the current context differs from
 * the most recent `_datadog_{N}` operation already in the event.
 *
 * - First checkpoint (no previous): uses number 0, parent_id = checkpointAnchorSpanId.
 * - Subsequent: picks max number + 1, reuses the previous checkpoint's parent_id,
 *   and saves only if trace context changed (ignoring parent-context fields).
 *
 * Caller is responsible for invoking this only when a save is appropriate — i.e.
 * the SDK is about to return Status: PENDING (see PENDING_TERMINATION_REASONS in
 * handler.js). This function does not re-check that.
 *
 * @param {object} tracer
 * @param {object} span - aws.durable.execute span
 * @param {object} durableContext - SDK's DurableContextImpl
 * @param {string | undefined} checkpointAnchorSpanId
 * @param {unknown} event - raw invocation event (has InitialExecutionState)
 * @returns {Promise<void>}
 */
async function saveTraceContextCheckpointIfUpdated (
  tracer, span, durableContext, checkpointAnchorSpanId, event,
) {
  try {
    const checkpointManager = durableContext.checkpoint ?? durableContext.checkpointManager
    if (typeof checkpointManager?.checkpoint !== 'function') return

    const currentHeaders = injectHeaders(tracer, span)
    if (!currentHeaders || Object.keys(currentHeaders).length === 0) return

    const latest = findLastCheckpointOrNull(event)

    let newNumber
    if (latest) {
      const latestHeaders = parseCheckpointPayload(latest.operation)
      if (!latestHeaders) return

      // Compare trace contexts ignoring x-datadog-parent-id, which always changes
      // since it reflects the active span at save time. The propagator emits keys
      // in a deterministic order, so JSON.stringify is a stable equality check.
      const latestParentId = latestHeaders['x-datadog-parent-id']
      delete currentHeaders['x-datadog-parent-id']
      delete latestHeaders['x-datadog-parent-id']
      if (JSON.stringify(currentHeaders) === JSON.stringify(latestHeaders)) return

      newNumber = latest.number + 1
      overrideParentId(currentHeaders, latestParentId)
    } else {
      newNumber = 0
      if (checkpointAnchorSpanId) overrideParentId(currentHeaders, checkpointAnchorSpanId)
    }

    const executionArn = event?.DurableExecutionArn || ''
    await saveCheckpoint(checkpointManager, executionArn, newNumber, currentHeaders)
  } catch (e) {
    log.debug('Failed to save trace context checkpoint', e)
  }
}

module.exports = {
  CHECKPOINT_NAME_PREFIX,
  saveTraceContextCheckpointIfUpdated,
}
