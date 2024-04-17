'use strict'

exports.createWrapFetch = function createWrapFetch (Request, ch) {
  return function wrapFetch (fetch) {
    if (typeof fetch !== 'function') return fetch

    return function (input, init) {
      if (!ch.start.hasSubscribers) return fetch.apply(this, arguments)

      const req = new Request(input, init)
      const headers = req.headers
      const ctx = { req, headers }

      return ch.tracePromise(() => fetch.call(this, req, { headers: ctx.headers }), ctx)
    }
  }
}
