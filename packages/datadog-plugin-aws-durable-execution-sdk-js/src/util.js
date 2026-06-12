'use strict'

const { createHash } = require('node:crypto')

/**
 * Populates the replay and operation_id tags for the op the DurableContextImpl is about to
 * run, deriving both from a single `getNextStepId()` call. `aws.durable.replayed` is always
 * set ('true' when the next stepId already has a SUCCEEDED checkpoint entry, i.e. the op will
 * be served from the SDK's checkpoint). `aws.durable.operation_id` — the 16-hex-char MD5 of
 * the stepId, mirroring the SDK's internal calculation — is only added when a stepId exists.
 * @param {Record<string, string>} meta - The span meta/tags object to populate.
 * @param {object} [ctxImpl] - The DurableContextImpl about to run the op.
 * @returns {void}
 */
function addOpMeta (meta, ctxImpl) {
  const stepId = ctxImpl?.getNextStepId?.()
  if (!stepId) {
    meta['aws.durable.replayed'] = 'false'
    return
  }
  const stepData = ctxImpl?._executionContext?.getStepData?.(stepId)
  meta['aws.durable.replayed'] = String(stepData?.Status === 'SUCCEEDED')
  meta['aws.durable.operation_id'] = createHash('md5').update(stepId).digest('hex').slice(0, 16)
}

/**
 * Returns the 0-indexed attempt number for the op the DurableContextImpl is about to
 * run: 0 for the original attempt, 1 for the first retry, 2 for the second, etc.
 * Defaults to 0 when no checkpoint exists yet (the very first execution before any
 * prior failures, before the START checkpoint).
 *
 * On a pending/retry checkpoint (the live run of an op), the production AWS Lambda
 * Durable service stores StepDetails.Attempt as "number of prior failed attempts",
 * so passing it through directly yields the correct 0-indexed semantic. The SDK's
 * own internal use also matches this — it computes the current attempt count as
 * `(stepData.StepDetails.Attempt || 0) + 1`.
 *
 * On a SUCCEEDED checkpoint (an op being replayed from its stored result), the same
 * field instead holds the 1-indexed number of the attempt that ultimately succeeded
 * (a first-try success reads as 1). We subtract 1 in that case so a replay reports
 * the same 0-indexed attempt as the original run did. This 1-indexing is
 * server-maintained observed behavior, not an SDK guarantee, so we floor at 0 to
 * never emit a negative attempt if a SUCCEEDED checkpoint ever lacks an Attempt field.
 *
 * @param {object} [ctxImpl]
 * @returns {number}
 */
function getOperationAttempt (ctxImpl) {
  const stepId = ctxImpl?.getNextStepId?.()
  if (!stepId) return 0
  const stepData = ctxImpl?._executionContext?.getStepData?.(stepId)
  const attempt = stepData?.StepDetails?.Attempt
  if (typeof attempt !== 'number') return 0
  return stepData.Status === 'SUCCEEDED' ? Math.max(0, attempt - 1) : attempt
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

module.exports = { addOpMeta, getOperationAttempt, unwrapDurableError }
