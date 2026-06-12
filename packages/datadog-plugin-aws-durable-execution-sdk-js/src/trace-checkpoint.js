'use strict'

const crypto = require('crypto')
const log = require('../../dd-trace/src/log')
const TextMapPropagator = require('../../dd-trace/src/opentracing/propagation/text_map')

const CHECKPOINT_NAME_PREFIX = '_datadog_'

// Propagator that injects only Datadog-style headers (`x-datadog-*`) regardless of the user's
// `DD_TRACE_PROPAGATION_STYLE_INJECT`. Checkpoints are written and read entirely by Datadog code,
// so honoring user style preferences would only complicate the payload contract. AWS runs a single
// tracer, so one lazily-built propagator suffices.
let datadogOnlyPropagator

function getDatadogOnlyPropagator (tracer) {
  if (datadogOnlyPropagator) return datadogOnlyPropagator
  const config = tracer._config
  // Shadow `tracePropagationStyle.inject` while inheriting every other field (x-datadog-tags length
  // cap, etc.) from the live config. Disable `legacyBaggageEnabled` only to keep `ot-baggage-*` out
  // of the checkpoint payload we persist (sensitive-data concern) — not a serverless-wide change.
  const shadowConfig = Object.create(config)
  shadowConfig.tracePropagationStyle = {
    ...config.tracePropagationStyle,
    inject: ['datadog'],
  }
  shadowConfig.legacyBaggageEnabled = false
  datadogOnlyPropagator = new TextMapPropagator(shadowConfig)
  return datadogOnlyPropagator
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
  const propagator = getDatadogOnlyPropagator(tracer)
  const ctx = typeof span?.context === 'function' ? span.context() : span
  propagator.inject(ctx, headers)
  return headers
}

/**
 * Mutate headers in-place to set parent_id to the provided value.
 * @param {Record<string, string>} headers
 * @param {string | number | undefined} parentId
 */
function overrideParentId (headers, parentId) {
  if (!parentId) return
  if (headers['x-datadog-trace-id']) {
    headers['x-datadog-parent-id'] = String(parentId)
  }
}

/**
 * Whether the current trace context warrants a new checkpoint over the previously-saved one.
 * @param {Record<string, string>} currentHeaders
 * @param {Record<string, string>} previousHeaders
 * @returns {boolean}
 */
function needsCheckpointUpdate (currentHeaders, previousHeaders) {
  for (const key of Object.keys(currentHeaders)) {
    if (currentHeaders[key] !== previousHeaders[key]) return true
  }
  return false
}

/**
 * Find the checkpoint with the highest N for _datadog_{N} in the event's operations.
 * @param {unknown} event
 * @returns {{ checkpointNumber: number, operation: object } | undefined}
 */
function findLastCheckpoint (event) {
  if (!event || typeof event !== 'object') return

  const operations = event.InitialExecutionState?.Operations
  if (!Array.isArray(operations)) return

  let highest
  for (const op of operations) {
    const name = op?.Name
    if (typeof name !== 'string' || !name.startsWith(CHECKPOINT_NAME_PREFIX)) continue
    const suffix = name.slice(CHECKPOINT_NAME_PREFIX.length)
    const checkpointNumber = Number.parseInt(suffix, 10)
    if (Number.isNaN(checkpointNumber) || String(checkpointNumber) !== suffix) continue

    if (!highest || checkpointNumber > highest.checkpointNumber) {
      highest = { checkpointNumber, operation: op }
    }
  }

  return highest
}

/**
 * Parse the JSON payload from a checkpoint STEP operation's Payload or StepDetails.Result.
 * @param {object} op
 * @returns {Record<string, string> | undefined}
 */
function parseCheckpointPayload (op) {
  try {
    const raw = op?.Payload ?? op?.StepDetails?.Result
    if (!raw || typeof raw !== 'string') return
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : undefined
  } catch {
    log.debug('Failed to parse checkpoint payload')
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
  await Promise.all([
    startPromise,
    succeedPromise,
  ])
  log.debug('Saved trace context checkpoint %s', name)
}

/**
 * Save a new trace-context checkpoint when the current context differs from
 * the most recent `_datadog_{N}` operation already in the event.
 *
 * Every checkpoint across the durable execution carries the same
 * `x-datadog-parent-id` so all resumed invocations attach to the same anchor:
 * - First checkpoint (no previous): anchor at `firstExecutionSpanId`.
 * - Subsequent: reuse the prior checkpoint's `x-datadog-parent-id` verbatim —
 *   that value originated from the first save and is the anchor we've been
 *   carrying forward.
 *
 * Caller is responsible for invoking this only when a save is appropriate — i.e.
 * the SDK is about to return Status: PENDING (see PENDING_TERMINATION_REASONS in
 * handler.js). This function does not re-check that.
 *
 * @param {object} tracer
 * @param {object} span - aws.durable.execute span
 * @param {object} durableContext - SDK's DurableContextImpl
 * @param {string | undefined} firstExecutionSpanId - span id of the first
 *   invocation's `aws.durable.execute` span. Only consulted on the very
 *   first save; ignored once a prior `_datadog_{N}` exists. We anchor at
 *   this span (which this integration owns) rather than its parent so the
 *   anchor doesn't depend on whatever upstream context happens to be
 *   active when `bindStart` fires.
 * @param {unknown} event - raw invocation event (has InitialExecutionState)
 * @returns {Promise<void>}
 */
async function saveTraceContextCheckpointIfUpdated (
  tracer, span, durableContext, firstExecutionSpanId, event,
) {
  try {
    const checkpointManager = durableContext.checkpoint ?? durableContext.checkpointManager
    if (typeof checkpointManager?.checkpoint !== 'function') return

    const currentHeaders = injectHeaders(tracer, span)
    if (currentHeaders['x-datadog-trace-id'] === undefined) return

    const latest = findLastCheckpoint(event)

    let newNumber
    if (latest) {
      const previousHeaders = parseCheckpointPayload(latest.operation)
      if (!previousHeaders) return

      // x-datadog-parent-id reflects the active span at save time and always differs, so exclude it
      // from the comparison. Capture the previous anchor first to carry it forward on a real update.
      // needsCheckpointUpdate only reads currentHeaders' keys, so deleting it from there is enough.
      const anchoredSpanId = previousHeaders['x-datadog-parent-id']
      delete currentHeaders['x-datadog-parent-id']
      if (!needsCheckpointUpdate(currentHeaders, previousHeaders)) return

      newNumber = latest.checkpointNumber + 1
      overrideParentId(currentHeaders, anchoredSpanId)
    } else {
      newNumber = 0
      if (firstExecutionSpanId) overrideParentId(currentHeaders, firstExecutionSpanId)
    }

    const executionArn = event?.DurableExecutionArn || ''
    await saveCheckpoint(checkpointManager, executionArn, newNumber, currentHeaders)
  } catch (e) {
    log.debug('Failed to save trace context checkpoint', e)
  }
}

module.exports = {
  saveTraceContextCheckpointIfUpdated,
}
