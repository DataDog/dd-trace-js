'use strict'

const { createHash } = require('node:crypto')

/**
 * Returns true if the op the DurableContextImpl is about to run will be served
 * from the SDK's checkpoint (i.e. the next stepId already has a SUCCEEDED entry).
 * @param {object} [ctxImpl]
 * @returns {boolean}
 */
function isReplayedOp (ctxImpl) {
  try {
    const stepId = ctxImpl?.getNextStepId?.()
    if (!stepId) return false
    const stepData = ctxImpl?._executionContext?.getStepData?.(stepId)
    return stepData?.Status === 'SUCCEEDED'
  } catch {
    return false
  }
}

/**
 * Returns the operation_id (16-hex-char MD5 of the next stepId) for the op the
 * DurableContextImpl is about to run, or undefined if unavailable. Mirrors the
 * SDK's internal `hashId`, which it uses for the `Id` field on checkpoint
 * updates and for `operationId` in its logging context.
 * @param {object} [ctxImpl]
 * @returns {string|undefined}
 */
function getOperationId (ctxImpl) {
  try {
    const stepId = ctxImpl?.getNextStepId?.()
    if (!stepId) return
    return createHash('md5').update(stepId).digest('hex').slice(0, 16)
  } catch {}
}

module.exports = { isReplayedOp, getOperationId }
