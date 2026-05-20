'use strict'

const { channel } = require('./instrument')

/**
 * Create a shimmer-compatible instrumentor for promise-returning APIs (e.g. `dns.promises.lookup`).
 * Mirrors `createCallbackInstrumentor`: same `<prefix>:start`, `:finish`, `:error` channels and
 * same context shape, so a plugin already subscribing to those channels for the callback variant
 * works for the promise variant with no changes.
 *
 * The returned wrapper:
 *  - calls through unmodified when there are no subscribers;
 *  - invokes `buildContext(thisArg, args)` to construct the context object; a return of
 *    `undefined` causes a bypass, letting callers enforce additional guards;
 *  - publishes `:start` via `runStores`, awaits the returned promise, and publishes either
 *    `:finish` (optionally setting `ctx.result` to the resolved value) or `:error` followed by
 *    `:finish`. Synchronous throws are routed through `:error` + rethrow.
 *
 * @param {string} prefix
 * @param {object} [options]
 * @param {boolean} [options.captureResult] set `ctx.result` to the promise's resolved value
 *   before publishing `:finish`. Plugins that tag spans from the call's return value rely on this.
 * @returns {(buildContext: (thisArg: unknown, args: unknown[]) => object | undefined) =>
 *   (fn: Function) => Function}
 */
function createPromiseInstrumentor (prefix, { captureResult = false } = {}) {
  const startCh = channel(prefix + ':start')
  const finishCh = channel(prefix + ':finish')
  const errorCh = channel(prefix + ':error')

  return function instrument (buildContext) {
    return function wrap (fn) {
      return function (...args) {
        if (!startCh.hasSubscribers) {
          return fn.apply(this, args)
        }

        const ctx = buildContext(this, args)
        if (ctx === undefined) {
          return fn.apply(this, args)
        }

        return startCh.runStores(ctx, () => {
          let promise
          try {
            promise = fn.apply(this, args)
          } catch (error) {
            void error.stack
            ctx.error = error
            errorCh.publish(ctx)
            throw error
          }

          return promise.then(
            result => {
              if (captureResult) {
                ctx.result = result
              }
              finishCh.runStores(ctx, () => {})
              return result
            },
            error => {
              ctx.error = error
              errorCh.publish(ctx)
              finishCh.runStores(ctx, () => {})
              throw error
            }
          )
        })
      }
    }
  }
}

module.exports = { createPromiseInstrumentor }
