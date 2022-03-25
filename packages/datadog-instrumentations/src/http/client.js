'use strict'

/* eslint-disable no-fallthrough */

const url = require('url')
const {
  channel,
  addHook,
  AsyncResource
} = require('../helpers/instrument')
const shimmer = require('../../../datadog-shimmer')

const log = require('../../../dd-trace/src/log')

const startClientCh = channel('apm:http:client:request:start')
const asyncEndClientCh = channel('apm:http:client:request:async-end')
const endClientCh = channel('apm:http:client:request:end')
const errorClientCh = channel('apm:http:client:request:error')

addHook({ name: 'https' }, hookFn)

addHook({ name: 'http' }, hookFn)

function hookFn (http) {
  patch(http, 'request')
  patch(http, 'get')

  return http
}

function patch (http, methodName) {
  shimmer.wrap(http, methodName, instrumentRequest)

  function instrumentRequest (request) {
    return function () {
      if (!startClientCh.hasSubscribers) {
        return request.apply(this, arguments)
      }
      const asyncResource = new AsyncResource('bound-anonymous-fn')

      let args

      try {
        args = normalizeArgs.apply(null, arguments)
      } catch (e) {
        log.error(e)
        return request.apply(this, arguments)
      }
      startClientCh.publish({ args, http })

      const ar = new AsyncResource('bound-anonymous-fn')

      let callback = args.callback

      if (callback) {
        callback = asyncResource.bind(callback)
      }

      const options = args.options
      const req = ar.bind(request).call(this, options, callback)
      const emit = req.emit

      req.emit = function (eventName, arg) {
        const finished = false
        const finish = (finished, req, res) => {
          if (!finished) {
            finished = true
            asyncEndClientCh.publish({ req, res })
          }
        }

        ar.runInAsyncScope(() => {
          switch (eventName) {
            case 'response': {
              const res = arg
              const listener = ar.bind(() => finish(finished, req, res))
              res.on('end', listener)
              res.on('error', listener)
              break
            }
            case 'connect':
            case 'upgrade':
              finish(finished, req, arg)
              break
            case 'error':
              errorClientCh.publish(arg)
            case 'abort': // deprecated and replaced by `close` in node 17
            case 'timeout':
            case 'close':
              finish(finished, req)
          }
        })

        return emit.apply(this, arguments)
      }

      endClientCh.publish(undefined)

      return req
    }
  }

  function normalizeArgs (inputURL, inputOptions, cb) {
    inputURL = normalizeOptions(inputURL)

    const [callback, inputOptionsNormalized] = normalizeCallback(inputOptions, cb, inputURL)
    const options = combineOptions(inputURL, inputOptionsNormalized)
    normalizeHeaders(options)
    const uri = url.format(options)

    return { uri, options, callback }
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
