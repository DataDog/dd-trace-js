'use strict'

const { createHash } = require('node:crypto')

/**
 * Returns true if the op the DurableContextImpl is about to run will be served
 * from the SDK's checkpoint (i.e. the next stepId already has a SUCCEEDED entry).
 * @param {object} [ctxImpl]
 * @returns {boolean}
 */
function isReplayedOp (ctxImpl) {
  const stepId = ctxImpl?.getNextStepId?.()
  if (!stepId) return false
  const stepData = ctxImpl?._executionContext?.getStepData?.(stepId)
  return stepData?.Status === 'SUCCEEDED'
}

/**
 * Returns the operation_id (16-hex-char MD5 of the next stepId) for the op the
 * DurableContextImpl is about to run, or undefined if unavailable. Mirrors the
 * SDK's internal calculations
 * @param {object} [ctxImpl]
 * @returns {string|undefined}
 */
function getOperationId (ctxImpl) {
  const stepId = ctxImpl?.getNextStepId?.()
  if (!stepId) return
  return createHash('md5').update(stepId).digest('hex').slice(0, 16)
}

/**
 * Returns the 1-indexed attempt number for the op the DurableContextImpl is about to run:
 * 1 for the original attempt, 2 for the first retry, etc., matching the AWS UI's
 * attempt-count convention. Defaults to 1 when no checkpoint exists yet (the very
 * first execution before the START checkpoint).
 *
 * AIDEV-NOTE: In production the AWS Lambda Durable service reports StepDetails.Attempt
 * 1-indexed (1 for the first attempt, 2 after the first retry, etc.) — matching what
 * the AWS UI displays. Pass it through directly. The SDK's own testing framework
 * returns the value 0-indexed instead, so test snapshots may emit lower numbers than
 * prod for the same logical state.
 *
 * @param {object} [ctxImpl]
 * @returns {number}
 */
function getOperationAttempt (ctxImpl) {
  const stepId = ctxImpl?.getNextStepId?.()
  if (!stepId) return 1
  const stepData = ctxImpl?._executionContext?.getStepData?.(stepId)
  const attempt = stepData?.StepDetails?.Attempt
  return typeof attempt === 'number' ? Math.max(1, attempt) : 1
}

/**
 * The SDK wraps user errors in typed classes (StepError, ChildContextError, etc.); we follow the
 * `.cause` chain to recover the user's original Error. SDK wrappers expose a string `errorType`
 * field, so the loop stops once we leave the wrapper hierarchy.
 * @param {{ error?: unknown } | unknown} ctxOrError
 * @returns {{ error?: unknown } | unknown}
 */
function unwrapDurableError (ctxOrError) {
  let err = ctxOrError?.error
  if (!(err instanceof Error)) return ctxOrError

  while (typeof err.errorType === 'string' && err.cause instanceof Error) {
    err = err.cause
  }
  return { ...ctxOrError, error: err }
}

module.exports = { isReplayedOp, getOperationId, getOperationAttempt, unwrapDurableError }
