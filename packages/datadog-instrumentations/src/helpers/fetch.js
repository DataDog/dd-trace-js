'use strict'

const { channel } = require('dc-polyfill')

exports.createWrapFetch = function createWrapFetch (Request, ch) {
  let loaded = false

  return function wrapFetch (fetch) {
    if (typeof fetch !== 'function') return fetch

    return function (input, init) {
      if (!loaded) {
        channel('dd-trace:instrumentation:load').publish({ name: 'fetch' })
        loaded = true
      }

      if (!ch.start.hasSubscribers) return fetch.apply(this, arguments)

      if (input instanceof Request) {
        const ctx = { req: input }

        return ch.tracePromise(() => fetch.call(this, input, init), ctx)
      } else {
        const req = new Request(input, init)
        const ctx = { req }

        return ch.tracePromise(() => fetch.call(this, req), ctx)
      }
    }
  }
}
