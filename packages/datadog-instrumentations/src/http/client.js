'use strict'

/* eslint-disable no-fallthrough */

const url = require('url')

const { EventEmitter } = require('events')

const { channel, addHook } = require('../helpers/instrument')
const shimmer = require('../../../datadog-shimmer')

const log = require('../../../dd-trace/src/log')
const { storage } = require('../../../datadog-core')

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

let ClientRequest

function noop () {}

function createAbortedClientRequest (http, args) {
  if (!ClientRequest) {
    const store = storage.getStore()
    storage.enterWith({ noop: true })

    const clientRequest = http.get('<invalid-url>')
    clientRequest.on('error', noop)
    ClientRequest = Object.getPrototypeOf(clientRequest).constructor

    storage.enterWith(store)
  }

  return new ClientRequest({
    ...args.options,
    agent: {
      addRequest: noop
    }
  })
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
        log.error(e)
        return request.apply(this, arguments)
      }

      const abortData = {
        abortController: new AbortController()
      }
      const ctx = { args, http, abortData }

      return startChannel.runStores(ctx, () => {
        let finished = false
        let callback = args.callback

        if (callback) {
          callback = function () {
            return asyncStartChannel.runStores(ctx, () => {
              return args.callback.apply(this, arguments)
            })
          }
        }

        const options = args.options

        const finish = () => {
          if (!finished) {
            finished = true
            finishChannel.publish(ctx)
          }
        }

        try {
          let req
          if (abortData.abortController?.signal.aborted) {
            req = createAbortedClientRequest(http, args)
            process.nextTick(() => {
              req.emit('error', abortData.error || new Error('Aborted'))
            })
          } else {
            req = request.call(this, options, callback)
          }
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

            return emit.apply(this, arguments)
          }

          return req
        } catch (e) {
          ctx.error = e
          errorChannel.publish(ctx)
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

  function combineOptions (inputURL, inputOptions) {
    if (typeof inputOptions === 'object') {
      return Object.assign(inputURL || {}, inputOptions)
    } else {
      return inputURL
    }
  }
  function normalizeHeaders (options) {
    options.headers = options.headers || {}
  }

  function normalizeCallback (inputOptions, callback, inputURL) {
    if (typeof inputOptions === 'function') {
      return [inputOptions, inputURL || {}]
    } else {
      return [callback, inputOptions]
    }
  }

  function normalizeOptions (inputURL) {
    if (typeof inputURL === 'string') {
      try {
        return urlToOptions(new url.URL(inputURL))
      } catch (e) {
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
