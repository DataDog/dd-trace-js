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
 * SDK's internal calculations
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

/**
 * The SDK wraps user errors in typed classes (StepError, ChildContextError, etc.). For
 * span tagging we want the user's original Error, so we follow the `.cause` chain back
 * out of the wrapper hierarchy. SDK wrappers expose a string `errorType` field, so the
 * loop stops once we leave the wrappers.
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
 * Wraps a DurablePromise's `.then`/`.catch`/`.finally` so the supplied
 * `onSettle(err)` callback fires exactly once when the underlying promise
 * settles — but only after user code first awaits / chains.
 *
 * Using `kind: 'Async'` in Orchestrion would side-chain `.then()` immediately
 * on the returned thenable, prematurely triggering the SDK's
 * `ensureExecution()` and `markOperationAwaited`. Instead, callers pair
 * `kind: 'Sync'` with this helper to preserve the SDK's lazy semantics.
 *
 * @param {object} dp - The returned DurablePromise instance.
 * @param {(err: unknown) => void} onSettle - Called with `undefined` on
 *   success or the rejection reason on failure. Invoked once.
 */
function observeDurablePromise (dp, onSettle) {
  if (!dp || typeof dp.then !== 'function') return
  const proto = Object.getPrototypeOf(dp)
  let settled = false

  // Use the prototype's `.then` directly to avoid recursing into our
  // instance-level wrapper. Underlying `_promise` is cached on first call so
  // this and any user-facing `.then`/`.catch`/`.finally` calls all chain off
  // the same native Promise.
  const attachSpy = () => {
    proto.then.call(dp,
      () => {
        if (settled) return
        settled = true
        onSettle()
      },
      err => {
        if (settled) return
        settled = true
        onSettle(err)
      }
    )
  }

  shimmer.wrap(dp, 'then', original => function (onFulfilled, onRejected) {
    attachSpy()
    return original.call(this, onFulfilled, onRejected)
  })
  shimmer.wrap(dp, 'catch', original => function (onRejected) {
    attachSpy()
    return original.call(this, onRejected)
  })
  shimmer.wrap(dp, 'finally', original => function (onFinally) {
    attachSpy()
    return original.call(this, onFinally)
  })
}

module.exports = { isReplayedOp, getOperationId, unwrapDurableError, observeDurablePromise }
