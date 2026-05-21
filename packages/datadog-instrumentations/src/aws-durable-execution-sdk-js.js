'use strict'

const { channel, tracingChannel } = require('dc-polyfill')
const shimmer = require('../../datadog-shimmer')
const { addHook, getHooks } = require('./helpers/instrument')

// Context methods that return a lazy DurablePromise. Their Orchestrion hooks use
// `kind: 'Sync'` so Orchestrion does not eagerly side-chain `.then()`. We side-chain
// the returned DurablePromise here instead and publish a `:settle` channel once it
// settles, preserving the SDK's lazy semantics.
const LAZY_DURABLE_PROMISE_METHODS = [
  'step',
  'invoke',
  'runInChildContext',
  'wait',
  'waitForCondition',
  'waitForCallback',
  'createCallback',
  'map',
  'parallel',
]

for (const method of LAZY_DURABLE_PROMISE_METHODS) {
  const orchestrionCh = tracingChannel(`orchestrion:@aws/durable-execution-sdk-js:DurableContextImpl_${method}`)
  const settleCh = channel(`apm:aws-durable-execution-sdk-js:${method}:settle`)

  orchestrionCh.end.subscribe(ctx => {
    if (!settleCh.hasSubscribers) return
    observeDurablePromise(ctx.result, error => {
      if (error !== undefined) ctx.error = error
      settleCh.publish(ctx)
    })
  })
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

for (const hook of getHooks('@aws/durable-execution-sdk-js')) {
  hook.file = null
  addHook(hook, exports => exports)
}
