'use strict'

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

module.exports = { isReplayedOp }
