'use strict'

exports.createWrapFetch = function createWrapFetch (Request, ch, onLoad) {
  return function wrapFetch (fetch) {
    if (typeof fetch !== 'function') return fetch

    return function (input, init) {
      if (onLoad) {
        onLoad()
        onLoad = undefined
      }

      if (!ch.start.hasSubscribers) return fetch.apply(this, arguments)

      if (input instanceof Request) {
        const ctx = { req: input }

        return ch.tracePromise(() => fetch.call(this, input, init), ctx)
      }
      const req = new Request(input, init)
      const ctx = { req }

      // The signal of `req` only weakly follows `init.signal` and is collected once `req` is unreachable, which
      // stops aborts from reaching the in-flight request. Passing it again lets `fetch` follow it directly.
      const signal = init?.signal

      return ch.tracePromise(() => signal ? fetch.call(this, req, { signal }) : fetch.call(this, req), ctx)
    }
  }
}
