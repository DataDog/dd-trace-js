'use strict'

const shimmer = require('../../../datadog-shimmer')
const { channel } = require('./instrument')

/**
 * Create a shimmer-compatible instrumentor for callback-style APIs whose work is offloaded to the
 * libuv worker thread pool (e.g. zlib.gzip, crypto.pbkdf2, dns.lookup). Builds a set of three
 * diagnostic channels at the given prefix (`<prefix>:start`, `:finish`, `:error`) and returns a
 * factory that produces shimmer wrappers driven by a caller-supplied `buildContext` function.
 *
 * The returned wrapper:
 *  - calls through unmodified when there are no subscribers or the last argument is not a callback;
 *  - invokes `buildContext(thisArg, args)` to construct the context object; a return of `undefined`
 *    also causes a bypass, letting callers enforce additional guards (e.g. minimum argument count);
 *  - publishes `:start` via `runStores`, wraps the callback to publish `:error` (on truthy error),
 *    optionally set `ctx.result` to the callback's first non-error argument, and publish `:finish`
 *    via `runStores`; publishes `:error` if the original call throws synchronously.
 *
 * @param {string} prefix
 * @param {object} [options]
 * @param {boolean} [options.captureResult=false] set `ctx.result` to the callback's first
 *   non-error argument before publishing `:finish`. Plugins that tag spans from the call's
 *   return value (e.g. the DNS lookup plugin) rely on this.
 * @returns {(buildContext: (thisArg: unknown, args: IArguments) => object | undefined) =>
 *   (fn: Function) => Function}
 */
function createCallbackInstrumentor (prefix, { captureResult = false } = {}) {
  const startCh = channel(prefix + ':start')
  const finishCh = channel(prefix + ':finish')
  const errorCh = channel(prefix + ':error')

  return function instrument (buildContext) {
    return function wrap (fn) {
      return function () {
        const lastIndex = arguments.length - 1
        const cb = arguments[lastIndex]
        if (!startCh.hasSubscribers || typeof cb !== 'function') {
          return fn.apply(this, arguments)
        }

        const ctx = buildContext(this, arguments)
        if (ctx === undefined) {
          return fn.apply(this, arguments)
        }

        return startCh.runStores(ctx, () => {
          arguments[lastIndex] = shimmer.wrapFunction(cb, cb => function (error, ...rest) {
            if (error) {
              ctx.error = error
              errorCh.publish(ctx)
            }
            if (captureResult) {
              ctx.result = rest[0]
            }
            return finishCh.runStores(ctx, cb, this, error, ...rest)
          })

          try {
            return fn.apply(this, arguments)
          } catch (error) {
            void error.stack // trigger getting the stack at the original throwing point
            ctx.error = error
            errorCh.publish(ctx)

            throw error
          }
        })
      }
    }
  }
}

module.exports = { createCallbackInstrumentor }
