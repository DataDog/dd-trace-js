'use strict'

/* eslint-disable no-fallthrough */

const url = require('node:url')
const { channel, addHook } = require('../helpers/instrument')
const shimmer = require('../../../datadog-shimmer')

const log = require('../../../dd-trace/src/log')

const startChannel = channel('apm:http:client:request:start')
const finishChannel = channel('apm:http:client:request:finish')
const endChannel = channel('apm:http:client:request:end')
const asyncStartChannel = channel('apm:http:client:request:asyncStart')
const errorChannel = channel('apm:http:client:request:error')

const names = ['http', 'https', 'node:http', 'node:https']

addHook({ name: names }, hookFn)

function hookFn (http) {
  patch(http, 'request')
  patch(http, 'get')

  return http
}

function patch (http, methodName) {
  shimmer.wrap(http, methodName, instrumentRequest)

  function instrumentRequest (request) {
    return function () {
      if (!startChannel.hasSubscribers) {
        return Reflect.apply(request, this, arguments)
      }

      let args

      try {
        args = Reflect.apply(normalizeArgs, null, arguments)
      } catch (err) {
        log.error('Error normalising http req arguments', err)
        return Reflect.apply(request, this, arguments)
      }

      const abortController = new AbortController()

      const ctx = { args, http, abortController }

      return startChannel.runStores(ctx, () => {
        let finished = false
        let callback = args.callback

        if (callback) {
          callback = shimmer.wrapFunction(args.callback, cb => function () {
            return asyncStartChannel.runStores(ctx, () => {
              return Reflect.apply(cb, this, arguments)
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
            return Reflect.apply(setTimeout, this, arguments)
          }

          req.emit = function (eventName, arg) {
            switch (eventName) {
              case 'response': {
                const res = arg
                ctx.res = res
                res.on('end', finish)
                res.on('error', finish)
                break
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

            return Reflect.apply(emit, this, arguments)
          }

          if (abortController.signal.aborted) {
            req.destroy(abortController.signal.reason || new Error('Aborted'))
          }

          return req
        } catch (err) {
          ctx.error = err
          errorChannel.publish(ctx)
          throw err
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

  function combineOptions (inputURL, inputOptions) {
    return inputOptions !== null && typeof inputOptions === 'object' ? Object.assign(inputURL || {}, inputOptions) : inputURL
  }
  function normalizeHeaders (options) {
    options.headers = options.headers || {}
  }

  function normalizeCallback (inputOptions, callback, inputURL) {
    return typeof inputOptions === 'function' ? [inputOptions, inputURL || {}] : [callback, inputOptions]
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
      href: url.href
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
