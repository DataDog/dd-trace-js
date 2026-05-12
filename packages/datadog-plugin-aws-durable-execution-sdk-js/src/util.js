'use strict'

const { createHash } = require('node:crypto')

const shimmer = require('../../datadog-shimmer')

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

/**
 * Using `kind: 'Async'` in Orchestrion would side-chain `.then()` immediately on the returned
 * thenable, prematurely triggering the SDK's `ensureExecution()` and `markOperationAwaited`.
 * Callers pair `kind: 'Sync'` with this helper so `onSettle` only fires after user code first
 * awaits / chains, preserving the SDK's lazy semantics.
 * @param {object} dp - The returned DurablePromise instance.
 * @param {(err: unknown) => void} onSettle - Called once with `undefined` on success or the
 *   rejection reason on failure.
 * @returns {void}
 */
function observeDurablePromise (dp, onSettle) {
  if (!dp || typeof dp.then !== 'function') return
  const proto = Object.getPrototypeOf(dp)
  let attached = false

  // Use the prototype's `.then` directly to avoid recursing into our
  // instance-level wrapper. The promise can only settle once, so calling
  // attachSpy at most once gives us exactly one onSettle invocation.
  const attachSpy = () => {
    if (attached) return
    attached = true
    proto.then.call(dp, () => onSettle(), err => onSettle(err))
  }

  shimmer.massWrap(dp, ['then', 'catch', 'finally'], original => function (...args) {
    attachSpy()
    return original.apply(this, args)
  })
}

module.exports = { isReplayedOp, getOperationId, unwrapDurableError, observeDurablePromise }
