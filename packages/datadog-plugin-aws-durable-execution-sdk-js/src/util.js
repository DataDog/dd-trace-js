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

module.exports = { addOpMeta, unwrapDurableError }
