'use strict'

function noop () {}

exports.createWrapFetch = function createWrapFetch (Request, ch, onLoad) {
  /**
   * Rejects an aborted request with the abort reason, once the body it would send is cancelled.
   * @param {Request} req request to send.
   * @param {import('undici-types').RequestInit | undefined} init options that fetch applies over `req`.
   * @param {unknown} reason abort reason.
   * @returns {Promise<never>}
   */
  function rejectAborted (req, init, reason) {
    try {
      // The request is built only to find the body to cancel.
      const request = init === undefined ? req : new Request(req, init)
      request.body?.cancel(reason).catch(noop)
    } catch {
      // The abort takes precedence over argument errors that fetch would raise, as in the other instrumentations
      // that can abort: the request is not attempted.
    }

    return Promise.reject(reason)
  }

  /**
   * @param {Function} fetch fetch implementation to call.
   * @param {unknown} thisArg receiver of the fetch call.
   * @param {Request} req request to send, published to subscribers.
   * @param {import('undici-types').RequestInit | undefined} init options that fetch applies over `req`.
   * @param {import('undici-types').RequestInit | undefined} options second argument of the fetch call.
   */
  function traceFetch (fetch, thisArg, req, init, options) {
    const abortController = new AbortController()

    return ch.tracePromise(() => {
      const { signal } = abortController
      if (signal.aborted) return rejectAborted(req, init, signal.reason)

      return fetch.call(thisArg, req, options)
    }, { req, abortController })
  }

  return function wrapFetch (fetch) {
    if (typeof fetch !== 'function') return fetch

    return function (input, init) {
      if (onLoad) {
        onLoad()
        onLoad = undefined
      }

      if (!ch.start.hasSubscribers) return fetch.apply(this, arguments)

      if (input instanceof Request) {
        // `init` is left for fetch to read once: it can hold one-shot values such as iterators and streams. It can
        // override the method, headers and body of `input`, but not its URL.
        return traceFetch(fetch, this, input, init, init)
      }
      const req = new Request(input, init)
      const signal = init?.signal

      // The signal of `req` only weakly follows `init.signal` and is collected once `req` is unreachable, which
      // stops aborts from reaching the in-flight request. Passing it again lets `fetch` follow it directly.
      const options = signal ? { signal, referrer: req.referrer, referrerPolicy: req.referrerPolicy } : undefined
      return traceFetch(fetch, this, req, undefined, options)
    }
  }
}
