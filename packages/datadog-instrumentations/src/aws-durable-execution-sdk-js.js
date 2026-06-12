'use strict'

const { channel, tracingChannel } = require('dc-polyfill')
const shimmer = require('../../datadog-shimmer')
const { addHook, getHooks } = require('./helpers/instrument')
const LAZY_DURABLE_PROMISE_METHODS = require('./aws-durable-execution-sdk-js-context-methods')

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

// Per-instance settle callback read by the shared prototype wrappers installed by
// `instrumentDurablePromiseProto`. Stored on the DurablePromise instance so the prototype
// wrappers stay allocation-free and the promise carries its own observer.
const ON_SETTLE = Symbol('_dd.durableExecution.onSettle')

const instrumentedProtos = new WeakSet()

/**
 * Wraps `then`/`catch`/`finally` on a DurablePromise prototype once so every instance shares
 * the same wrappers instead of being re-wrapped individually. The wrappers side-chain a settle
 * observer the first time user code chains off the promise, then clear `ON_SETTLE` so the
 * observer attaches at most once (a promise settles only once). Instances we don't observe
 * never set `ON_SETTLE`, so for them the wrappers are a single property read and a passthrough.
 * @param {object} proto - The DurablePromise prototype (`Object.getPrototypeOf(dp)`).
 * @returns {void}
 */
function instrumentDurablePromiseProto (proto) {
  if (instrumentedProtos.has(proto)) return
  instrumentedProtos.add(proto)

  // Capture the genuine `.then` before wrapping so the settle observer side-chains without
  // recursing back into the wrapper below.
  const originalThen = proto.then

  shimmer.massWrap(proto, ['then', 'catch', 'finally'], original => function (...args) {
    const onSettle = this[ON_SETTLE]
    if (onSettle !== undefined) {
      this[ON_SETTLE] = undefined
      originalThen.call(this, () => onSettle(), err => onSettle(err))
    }
    return original.apply(this, args)
  })
}

/**
 * Registers a settle observer on a returned DurablePromise. Callers pair `kind: 'Sync'` with this
 * helper so `onSettle` only fires after user code first awaits / chains, preserving the SDK's
 * lazy semantics.
 * @param {object} dp - The returned DurablePromise instance.
 * @param {(err: unknown) => void} onSettle - Called once with `undefined` on success or the
 *   rejection reason on failure.
 * @returns {void}
 */
function observeDurablePromise (dp, onSettle) {
  if (!dp || typeof dp.then !== 'function') return
  instrumentDurablePromiseProto(Object.getPrototypeOf(dp))
  dp[ON_SETTLE] = onSettle
}

for (const hook of getHooks('@aws/durable-execution-sdk-js')) {
  hook.file = null
  addHook(hook, exports => exports)
}
