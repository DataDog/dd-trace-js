'use strict'

const { createHash } = require('node:crypto')

// A checkpoint in one of these terminal states means the operation is served from the checkpoint
// on a replay rather than executed: the SDK reloads a SUCCEEDED result or re-raises a FAILED error
// without running the user function. Both also carry the 1-indexed attempt that reached the terminal
// state, so both need the same normalization to agree with the 0-indexed live run.
const REPLAYED_STATUSES = new Set(['SUCCEEDED', 'FAILED'])

/**
 * Resolves the SDK's next stepId and its checkpoint entry in a single pass, so one span start can
 * feed both addOpMeta and getOperationAttempt without traversing the SDK internals twice. `stepData`
 * is undefined when there is no next stepId, or no checkpoint entry exists for it yet.
 * @param {object} [ctxImpl] - The DurableContextImpl about to run the op.
 * @returns {{ stepId: string | undefined, stepData: object | undefined }}
 */
function getStepDataForNext (ctxImpl) {
  const stepId = ctxImpl?.getNextStepId?.()
  const stepData = stepId ? ctxImpl?._executionContext?.getStepData?.(stepId) : undefined
  return { stepId, stepData }
}

/**
 * Populates the replay and operation_id tags from a pre-resolved step lookup (see
 * getStepDataForNext). `aws.durable.replayed` is always set ('true' when the next stepId already
 * has a terminal checkpoint entry — SUCCEEDED or FAILED — i.e. the op will be served from the SDK's
 * checkpoint rather than executed). `aws.durable.operation_id` — the 16-hex-char MD5 of the stepId,
 * mirroring the SDK's internal calculation — is only added when a stepId exists.
 * @param {Record<string, string>} meta - The span meta/tags object to populate.
 * @param {{ stepId?: string, stepData?: object }} stepInfo - Resolved next stepId and checkpoint entry.
 * @returns {void}
 */
function addOpMeta (meta, { stepId, stepData }) {
  if (!stepId) {
    meta['aws.durable.replayed'] = 'false'
    return
  }
  meta['aws.durable.replayed'] = String(REPLAYED_STATUSES.has(stepData?.Status))
  meta['aws.durable.operation_id'] = createHash('md5').update(stepId).digest('hex').slice(0, 16)
}

/**
 * Returns the 0-indexed attempt number for the op (0 original, 1 first retry, …) from a pre-resolved
 * checkpoint entry (see getStepDataForNext), defaulting to 0 before any checkpoint exists.
 *
 * StepDetails.Attempt is indexed differently depending on checkpoint status: on a pending/retry
 * checkpoint it's the count of prior failed attempts (already 0-indexed), but on a terminal
 * checkpoint read on replay (SUCCEEDED or FAILED) it's the 1-indexed attempt that reached that
 * state. We subtract 1 in the terminal case so a replay agrees with the original run, flooring at
 * 0 since the 1-indexing is observed server behavior, not an SDK guarantee.
 *
 * @param {object} [stepData] - The checkpoint entry for the next stepId.
 * @returns {number}
 */
function getOperationAttempt (stepData) {
  const attempt = stepData?.StepDetails?.Attempt
  if (!Number.isFinite(attempt)) return 0
  return REPLAYED_STATUSES.has(stepData.Status) ? Math.max(0, attempt - 1) : attempt
}

/**
 * The SDK wraps user errors in typed classes (StepError, ChildContextError, etc.); we follow the
 * `.cause` chain to recover the user's original Error. SDK wrappers expose a string `errorType`
 * field, so the loop stops once we leave the wrapper hierarchy.
 * @param {{ error?: unknown }} ctx
 * @returns {unknown} the unwrapped error, or `ctx.error` unchanged when it isn't an Error
 */
function unwrapDurableError (ctx) {
  let err = ctx?.error
  if (!(err instanceof Error)) return err

  while (typeof err.errorType === 'string' && err.cause instanceof Error) {
    err = err.cause
  }
  return err
}

module.exports = { addOpMeta, getOperationAttempt, getStepDataForNext, unwrapDurableError }
