'use strict'

/* eslint-disable no-fallthrough */

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

const names = ['http', 'https', 'node:http', 'node:https']

addHook({ name: names }, hookFn)

function hookFn (http) {
  patch(http, 'request')
  patch(http, 'get')

  return http
}

function combineOptions (inputURL, inputOptions) {
  return inputOptions !== null && typeof inputOptions === 'object'
    ? Object.assign(inputURL || {}, inputOptions)
    : inputURL
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
        res.read = function () {
          const chunk = originalRead.apply(this, arguments)
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
        resumeResponse(res)
      }
    },
  }
}

/**
 * Resumes the response stream to drain unconsumed data.
 *
 * @param {import('http').IncomingMessage} res
 */
function resumeResponse (res) {
  if (!res) return
  if (typeof res.resume !== 'function') return
  if (res.destroyed) return
  if (res.readableFlowing) return
  if (res.readable === false) return

  res.resume()
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
        let finished = false
        let callback = args.callback

        if (callback) {
          callback = shimmer.wrapFunction(args.callback, cb => function () {
            return asyncStartChannel.runStores(ctx, () => {
              return cb.apply(this, arguments)
            })
          })
        }

        const options = args.options

        const finish = () => {
          if (!finished) {
            finished = true
            finishChannel.publish(ctx)
          }
        }

        try {
          const req = request.call(this, options, callback)
          const emit = req.emit
          const setTimeout = req.setTimeout

          ctx.req = req

          // tracked to accurately discern custom request socket timeout
          let customRequestTimeout = false
          req.setTimeout = function () {
            customRequestTimeout = true
            return setTimeout.apply(this, arguments)
          }

          req.emit = function (eventName, arg) {
            switch (eventName) {
              case 'response': {
                const res = arg
                ctx.res = res
                res.once('end', finish)
                res.once(errorMonitor, finish)

                const instrumentation = setupResponseInstrumentation(ctx, res)

                if (!instrumentation) {
                  break
                }

                const result = emit.apply(this, arguments)

                instrumentation.finalizeIfNeeded()

                return result
              }
              case 'connect':
              case 'upgrade':
                ctx.res = arg
                finish()
                break
              case 'error':
              case 'timeout':
                ctx.error = arg
                ctx.customRequestTimeout = customRequestTimeout
                errorChannel.publish(ctx)
              case 'abort': // deprecated and replaced by `close` in node 17
              case 'close':
                finish()
            }

            return emit.apply(this, arguments)
          }

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
            finish()
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
