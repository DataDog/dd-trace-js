'use strict'

const dc = require('dc-polyfill')

const { channel } = require('./instrument')

/**
 * Shimmer-compatible instrumentor for promise-returning APIs (e.g. `dns.promises.lookup`).
 * Mirrors `createCallbackInstrumentor`'s channel triplet (`<prefix>:start`, `:finish`, `:error`)
 * so a plugin subscribing to those channels for the callback variant works for the promise
 * variant unchanged. `:finish` is the `tracingChannel` `asyncEnd` slot, so it fires after the
 * promise settles with `ctx.result` set to the resolved value.
 *
 * @param {string} prefix
 * @returns {(buildContext: (thisArg: unknown, args: unknown[]) => object | undefined) =>
 *   (fn: Function) => Function}
 */
function createPromiseInstrumentor (prefix) {
  const start = channel(prefix + ':start')
  const finish = channel(prefix + ':finish')
  const error = channel(prefix + ':error')
  const tracing = dc.tracingChannel({
    start,
    end: channel(prefix + ':end'),
    asyncStart: channel(prefix + ':asyncStart'),
    asyncEnd: finish,
    error,
  })

  return function instrument (buildContext) {
    return function wrap (fn) {
      return function (...args) {
        if (!start.hasSubscribers) return fn.apply(this, args)
        const ctx = buildContext(this, args)
        if (ctx === undefined) return fn.apply(this, args)
        return tracing.tracePromise(fn, ctx, this, ...args)
      }
    }
  }
}

module.exports = { createPromiseInstrumentor }
