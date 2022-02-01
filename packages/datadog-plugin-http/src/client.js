'use strict'

const url = require('url')
const log = require('../../dd-trace/src/log')
const tags = require('../../../ext/tags')
const kinds = require('../../../ext/kinds')
const formats = require('../../../ext/formats')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')
const { storage } = require('../../datadog-core')
const { addErrorToSpan, getServiceName, hasAmazonSignature, client } = require('../../dd-trace/src/plugins/util/web')

const HTTP_HEADERS = formats.HTTP_HEADERS
const HTTP_STATUS_CODE = tags.HTTP_STATUS_CODE
const HTTP_REQUEST_HEADERS = tags.HTTP_REQUEST_HEADERS
const HTTP_RESPONSE_HEADERS = tags.HTTP_RESPONSE_HEADERS
const SPAN_KIND = tags.SPAN_KIND
const CLIENT = kinds.CLIENT

function patch (http, methodName, tracer, config) {
  config = normalizeConfig(config)
  this.wrap(http, methodName, fn => makeRequestTrace(fn))

  function makeRequestTrace (request) {
    return function requestTrace () {
      const store = storage.getStore()

      if (store && store.noop) return request.apply(this, arguments)

      let args

      try {
        args = normalizeArgs.apply(null, arguments)
      } catch (e) {
        log.error(e)
        return request.apply(this, arguments)
      }

      const options = args.options
      const agent = options.agent || options._defaultAgent || http.globalAgent
      const protocol = options.protocol || agent.protocol || 'http:'
      const hostname = options.hostname || options.host || 'localhost'
      const host = options.port ? `${hostname}:${options.port}` : hostname
      const path = options.path ? options.path.split(/[?#]/)[0] : '/'
      const uri = `${protocol}//${host}${path}`

      let callback = args.callback

      const method = (options.method || 'GET').toUpperCase()

      const scope = tracer.scope()
      const childOf = scope.active()
      const span = tracer.startSpan('http.request', {
        childOf,
        tags: {
          [SPAN_KIND]: CLIENT,
          'service.name': getServiceName(tracer, config, options),
          'resource.name': method,
          'span.type': 'http',
          'http.method': method,
          'http.url': uri
        }
      })

      if (!(hasAmazonSignature(options) || !config.propagationFilter(uri))) {
        tracer.inject(span, HTTP_HEADERS, options.headers)
      }

      analyticsSampler.sample(span, config.measured)

      callback = scope.bind(callback, childOf)

      const req = scope.bind(request, span).call(this, options, callback)
      const emit = req.emit

      req.emit = function (eventName, arg) {
        switch (eventName) {
          case 'response': {
            const res = arg

            scope.bind(res)

            res.on('end', () => finish(req, res, span, config))

            break
          }
          case 'error':
            addErrorToSpan(span, arg)
          case 'abort': // eslint-disable-line no-fallthrough
          case 'timeout': // eslint-disable-line no-fallthrough
            finish(req, null, span, config)
        }

        return emit.apply(this, arguments)
      }

      scope.bind(req)

      return req
    }
  }

  function finish (req, res, span, config) {
    if (res) {
      span.setTag(HTTP_STATUS_CODE, res.statusCode)

      if (!config.validateStatus(res.statusCode)) {
        span.setTag('error', 1)
      }

      addResponseHeaders(res, span, config)
    } else {
      span.setTag('error', 1)
    }

    addRequestHeaders(req, span, config)

    config.hooks.request(span, req, res)

    span.finish()
  }

  function addRequestHeaders (req, span, config) {
    config.headers.forEach(key => {
      const value = req.getHeader(key)

      if (value) {
        span.setTag(`${HTTP_REQUEST_HEADERS}.${key}`, value)
      }
    })
  }

  function addResponseHeaders (res, span, config) {
    config.headers.forEach(key => {
      const value = res.headers[key]

      if (value) {
        span.setTag(`${HTTP_RESPONSE_HEADERS}.${key}`, value)
      }
    })
  }

  function normalizeArgs (inputURL, inputOptions, cb) {
    inputURL = normalizeOptions(inputURL)

    const [callback, inputOptionsNormalized] = normalizeCallback(inputOptions, cb, inputURL)
    const options = combineOptions(inputURL, inputOptionsNormalized)
    normalizeHeaders(options)
    const uri = url.format(options)

    return { uri, options, callback }
  }

  function normalizeCallback (inputOptions, callback, inputURL) {
    if (typeof inputOptions === 'function') {
      return [inputOptions, inputURL || {}]
    } else {
      return [callback, inputOptions]
    }
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

  // https://github.com/nodejs/node/blob/7e911d8b03a838e5ac6bb06c5b313533e89673ef/lib/internal/url.js#L1271
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
}

function unpatch (http) {
  this.unwrap(http, 'request')
  this.unwrap(http, 'get')
}

function normalizeConfig (config) {
  config = config.client || config

  return client.normalizeConfig(config)
}

module.exports = [
  {
    name: 'http',
    patch: function (http, tracer, config) {
      if (config.client === false) return

      patch.call(this, http, 'request', tracer, config)
      /**
       * References internal to modules, such as `http(s).get` calling
       * `http(s).request`, do not use externally patched versions, which is
       * why we need to also patch `get` here separately.
       */
      patch.call(this, http, 'get', tracer, config)
    },
    unpatch
  },
  {
    name: 'https',
    patch: function (http, tracer, config) {
      if (config.client === false) return

      patch.call(this, http, 'request', tracer, config)
      patch.call(this, http, 'get', tracer, config)
    },
    unpatch
  }
]
