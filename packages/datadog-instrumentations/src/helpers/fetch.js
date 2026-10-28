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
      let signal
      if (init && (typeof init === 'object' || typeof init === 'function')) {
        // Capture the native signal read without changing other getters or their receiver.
        init = new Proxy(init, {
          /**
           * @param {import('undici').RequestInit} target
           * @param {string | symbol} key
           */
          get (target, key) {
            const value = Reflect.get(target, key, target)
            if (key === 'signal') signal = value
            return value
          },
        })
      }
      const req = new Request(input, init)
      const ctx = { req }

      // The signal of `req` only weakly follows `init.signal` and is collected once `req` is unreachable, which
      // stops aborts from reaching the in-flight request. Passing it again lets `fetch` follow it directly.
      const options = signal ? { signal, referrer: req.referrer, referrerPolicy: req.referrerPolicy } : undefined
      return ch.tracePromise(() => fetch.call(this, req, options), ctx)
    }
  }
}
