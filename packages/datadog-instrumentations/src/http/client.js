'use strict'

const url = require('url')
const { errorMonitor } = require('events')
const { channel, addHook } = require('../helpers/instrument')
const shimmer = require('../../../datadog-shimmer')

const log = require('../../../dd-trace/src/log')

const startChannel = channel('apm:http:client:request:start')
const finishChannel = channel('apm:http:client:request:finish')
const endChannel = channel('apm:http:client:request:end')
const asyncStartChannel = channel('apm:http:client:request:asyncStart')
const errorChannel = channel('apm:http:client:request:error')
const responseFinishChannel = channel('apm:http:client:response:finish')

// Subscribe at module load. Node 18+ publishes this for every client response
// *before* invoking the user's `'response'` listeners, and unlike a
// `req.once('response')` listener the subscription does not bump
// `req.listenerCount('response')` — so Node's `_dump()` fallback that drains
// an unread response stays intact.
const nativeClientResponseFinishChannel = channel('http.client.response.finish')

const requestContexts = new WeakMap()

nativeClientResponseFinishChannel.subscribe(onNativeClientResponseFinish)

addHook({ name: 'http' }, hookFn)
addHook({ name: 'https' }, hookFn)

/**
 * @param {{ finished?: boolean }} ctx Instrumentation context. Mutated with `finished`.
 */
function finishRequest (ctx) {
  if (!ctx.finished) {
    ctx.finished = true
    finishChannel.publish(ctx)
  }
}

/**
 * @param {{ request: import('http').ClientRequest, response: import('http').IncomingMessage }} payload
 */
function onNativeClientResponseFinish ({ request, response }) {
  const ctx = requestContexts.get(request)
  if (ctx === undefined) return

  ctx.res = response
  const onResponseSettled = () => finishRequest(ctx)
  response.once('end', onResponseSettled)
  response.once(errorMonitor, onResponseSettled)

  const instrumentation = setupResponseInstrumentation(ctx, response)
  if (instrumentation) {
    queueMicrotask(instrumentation.finalizeIfNeeded)
  }
}

function hookFn (http) {
  patch(http, 'request')
  patch(http, 'get')

  return http
}

// `inputURL` may be the user's options object (for the `http.request(options)`
// shape); never write directly into it. The result is later mutated by
// `normalizeHeaders` and read by `url.format`, so the merged object must be
// owned by the tracer. `undefined` means "no URL supplied" — Node merges
// with the options object or its defaults, so build a tracer-owned
// options-only shape and let tracing proceed. `null`/primitive first args
// are returned as-is so `normalizeHeaders` throws and the surrounding
// try/catch in `instrumentRequest` falls through to the native request;
// spreading a primitive yields `{}`, which would silently turn an invalid
// `http.request(123)` into a synthesized localhost request.
function combineOptions (inputURL, inputOptions) {
  if (inputURL === undefined) {
    return inputOptions !== null && typeof inputOptions === 'object' ? { ...inputOptions } : {}
  }
  if (inputURL === null || (typeof inputURL !== 'object' && typeof inputURL !== 'function')) {
    return inputURL
  }
  if (inputOptions !== null && typeof inputOptions === 'object') {
    return { ...inputURL, ...inputOptions }
  }
  return { ...inputURL }
}
function normalizeHeaders (options) {
  options.headers ??= {}
}

function normalizeCallback (inputOptions, callback, inputURL) {
  return typeof inputOptions === 'function' ? [inputOptions, inputURL || {}] : [callback, inputOptions]
}

/**
 * Wires the downstream response so we can observe when the customer consumes
 * the body and when the stream finishes
 *
 * @param {object} ctx - Instrumentation context
 * @param {import('http').IncomingMessage} res - The downstream response object.
 * @returns {{ finalizeIfNeeded: () => void }|null} Cleanup helper used for drain.
 */
function setupResponseInstrumentation (ctx, res) {
  const shouldInstrumentFinish = responseFinishChannel.hasSubscribers

  if (!shouldInstrumentFinish) {
    return null
  }

  let bodyConsumed = false
  let finishCalled = false
  let originalRead = null
  let dataListenerAdded = false
  let dataReadStarted = false

  const { shouldCollectBody } = ctx
  const bodyChunks = shouldCollectBody ? [] : null

  const collectChunk = chunk => {
    if (!shouldCollectBody || !chunk) return

    if (typeof chunk === 'string') {
      bodyChunks.push(chunk)
    } else if (Buffer.isBuffer(chunk)) {
      bodyChunks.push(chunk)
    } else {
      // Handle Uint8Array or other array-like types
      bodyChunks.push(Buffer.from(chunk))
    }
  }

  // Listen for body consumption
  const onNewListener = (eventName) => {
    if (eventName === 'data' || eventName === 'readable') {
      bodyConsumed = true

      // For 'data' events, add our own listener to collect chunks
      if (eventName === 'data' && !dataListenerAdded && !dataReadStarted) {
        dataListenerAdded = true
        res.on('data', collectChunk)
      }

      // For 'readable' events, wrap the read() method
      if (eventName === 'readable' && !originalRead && !dataListenerAdded && typeof res.read === 'function') {
        originalRead = res.read
        res.read = function (...args) {
          const chunk = originalRead.apply(this, args)
          if (!dataListenerAdded) {
            dataReadStarted = true
            collectChunk(chunk)
          }
          return chunk
        }
      }
    }
  }

  res.on('newListener', onNewListener)

  // Cleanup function to restore original behavior
  const cleanup = () => {
    res.off('newListener', onNewListener)
    res.off('data', collectChunk)

    if (originalRead) {
      res.read = originalRead
      originalRead = null
    }
  }

  const notifyFinish = () => {
    if (finishCalled) return
    finishCalled = true

    // Combine collected chunks into a single body
    let body = null
    if (bodyChunks?.length) {
      const firstChunk = bodyChunks[0]
      body = typeof firstChunk === 'string'
        ? bodyChunks.join('')
        : Buffer.concat(bodyChunks)
    }

    responseFinishChannel.publish({ ctx, res, body })
    cleanup()
  }

  res.once('end', notifyFinish)
  res.once('close', notifyFinish)

  return {
    finalizeIfNeeded () {
      if (!bodyConsumed) {
        // Body not consumed, resume to complete the response
        notifyFinish()
      }
    },
  }
}

function patch (http, methodName) {
  shimmer.wrap(http, methodName, instrumentRequest)

  function instrumentRequest (request) {
    return function () {
      if (!startChannel.hasSubscribers) {
        return request.apply(this, arguments)
      }

      let args

      try {
        args = normalizeArgs.apply(null, arguments)
      } catch (e) {
        log.error('Error normalising http req arguments', e)
        return request.apply(this, arguments)
      }

      const abortController = new AbortController()

      const ctx = { args, http, abortController }

      return startChannel.runStores(ctx, () => {
        let callback = args.callback

        if (callback) {
          callback = shimmer.wrapFunction(args.callback, cb => function (...args) {
            return asyncStartChannel.runStores(ctx, () => {
              return cb.apply(this, args)
            })
          })
        }

        const options = args.options

        try {
          const req = request.call(this, options, callback)
          const setTimeout = req.setTimeout

          ctx.req = req
          requestContexts.set(req, ctx)

          // tracked to accurately discern custom request socket timeout
          ctx.customRequestTimeout = false
          req.setTimeout = function (...args) {
            ctx.customRequestTimeout = true
            return setTimeout.apply(this, args)
          }

          // Per-event listeners — not a lifetime `req.emit` reassignment — so
          // the dd-trace frame stays off the stack the user's listeners see.
          // See https://github.com/DataDog/dd-trace-js/issues/1564.
          req.once('connect', (res) => {
            ctx.res = res
            finishRequest(ctx)
          })

          req.once('upgrade', (res) => {
            ctx.res = res
            finishRequest(ctx)
          })

          req.on(errorMonitor, (error) => {
            ctx.error = error
            errorChannel.publish(ctx)
            finishRequest(ctx)
          })

          req.once('timeout', () => {
            errorChannel.publish(ctx)
            finishRequest(ctx)
          })

          req.once('close', () => finishRequest(ctx))

          if (abortController.signal.aborted) {
            req.destroy(abortController.signal.reason || new Error('Aborted'))
          }

          return req
        } catch (e) {
          ctx.error = e
          errorChannel.publish(ctx)
          // if the initial request failed, ctx.req will be unset, we must close the span here
          // fix for: https://github.com/DataDog/dd-trace-js/issues/5016
          if (!ctx.req) {
            finishRequest(ctx)
          }
          throw e
        } finally {
          endChannel.publish(ctx)
        }
      })
    }
  }

  function normalizeArgs (inputURL, inputOptions, cb) {
    const originalUrl = inputURL
    inputURL = normalizeOptions(inputURL)

    const [callback, inputOptionsNormalized] = normalizeCallback(inputOptions, cb, inputURL)
    const options = combineOptions(inputURL, inputOptionsNormalized)
    normalizeHeaders(options)
    const uri = url.format(options)

    return { uri, options, callback, originalUrl }
  }

  function normalizeOptions (inputURL) {
    if (typeof inputURL === 'string') {
      try {
        return urlToOptions(new url.URL(inputURL))
      } catch {
        // eslint-disable-next-line n/no-deprecated-api
        return url.parse(inputURL)
      }
    } else if (inputURL instanceof url.URL) {
      return urlToOptions(inputURL)
    } else {
      return inputURL
    }
  }

  function urlToOptions (url) {
    const agent = url.agent || http.globalAgent
    const options = {
      protocol: url.protocol || agent.protocol,
      hostname: typeof url.hostname === 'string' && url.hostname.startsWith('[')
        ? url.hostname.slice(1, -1)
        : url.hostname ||
          url.host ||
          'localhost',
      hash: url.hash,
      search: url.search,
      pathname: url.pathname,
      path: `${url.pathname || ''}${url.search || ''}`,
      href: url.href,
    }
    if (url.port !== '') {
      options.port = Number(url.port)
    }
    if (url.username || url.password) {
      options.auth = `${url.username}:${url.password}`
    }
    return options
  }
}
