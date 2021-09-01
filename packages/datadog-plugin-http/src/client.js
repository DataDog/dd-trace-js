'use strict'

const url = require('url')
const opentracing = require('opentracing')
const log = require('../../dd-trace/src/log')
const constants = require('../../dd-trace/src/constants')
const tags = require('../../../ext/tags')
const kinds = require('../../../ext/kinds')
const formats = require('../../../ext/formats')
const urlFilter = require('../../dd-trace/src/plugins/util/urlfilter')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')

const Reference = opentracing.Reference

const HTTP_HEADERS = formats.HTTP_HEADERS
const HTTP_STATUS_CODE = tags.HTTP_STATUS_CODE
const HTTP_REQUEST_HEADERS = tags.HTTP_REQUEST_HEADERS
const HTTP_RESPONSE_HEADERS = tags.HTTP_RESPONSE_HEADERS
const SPAN_KIND = tags.SPAN_KIND
const CLIENT = kinds.CLIENT
const REFERENCE_CHILD_OF = opentracing.REFERENCE_CHILD_OF
const REFERENCE_NOOP = constants.REFERENCE_NOOP

function patch (http, methodName, tracer, config) {
  config = normalizeConfig(tracer, config)
  this.wrap(http, methodName, fn => makeRequestTrace(fn))

  function makeRequestTrace (request) {
    return function requestTrace () {
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
      const type = config.filter(uri) ? REFERENCE_CHILD_OF : REFERENCE_NOOP
      const span = tracer.startSpan('http.request', {
        references: [
          new Reference(type, childOf)
        ],
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
            addError(span, arg)
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

  function addError (span, error) {
    span.addTags({
      'error.type': error.name,
      'error.msg': error.message,
      'error.stack': error.stack
    })

    return error
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

function getHost (options) {
  if (typeof options === 'string') {
    return url.parse(options).host
  }

  const hostname = options.hostname || options.host || 'localhost'
  const port = options.port

  return [hostname, port].filter(val => val).join(':')
}

function getServiceName (tracer, config, options) {
  if (config.splitByDomain) {
    return getHost(options)
  } else if (config.service) {
    return config.service
  }

  return `${tracer._service}-http-client`
}

function hasAmazonSignature (options) {
  if (!options) {
    return false
  }

  if (options.headers) {
    const headers = Object.keys(options.headers)
      .reduce((prev, next) => Object.assign(prev, {
        [next.toLowerCase()]: options.headers[next]
      }), {})

    if (headers['x-amz-signature']) {
      return true
    }

    if ([].concat(headers['authorization']).some(startsWith('AWS4-HMAC-SHA256'))) {
      return true
    }
  }

  return options.path && options.path.toLowerCase().indexOf('x-amz-signature=') !== -1
}

function startsWith (searchString) {
  return value => String(value).startsWith(searchString)
}

function unpatch (http) {
  this.unwrap(http, 'request')
  this.unwrap(http, 'get')
}

function getStatusValidator (config) {
  if (typeof config.validateStatus === 'function') {
    return config.validateStatus
  } else if (config.hasOwnProperty('validateStatus')) {
    log.error('Expected `validateStatus` to be a function.')
  }
  return code => code < 400 || code >= 500
}

function getFilter (tracer, config) {
  const blocklist = tracer._url ? [getAgentFilter(tracer._url)] : []

  config = Object.assign({}, config, {
    blocklist: blocklist.concat(config.blocklist || [])
  })

  return urlFilter.getFilter(config)
}

function getAgentFilter (url) {
  // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_Expressions#Escaping
  const agentFilter = url.href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  return RegExp(`^${agentFilter}.*$`, 'i')
}

function normalizeConfig (tracer, config) {
  config = config.client || config

  const validateStatus = getStatusValidator(config)
  const filter = getFilter(tracer, config)
  const propagationFilter = getFilter(tracer, { blocklist: config.propagationBlocklist })
  const headers = getHeaders(config)
  const hooks = getHooks(config)

  return Object.assign({}, config, {
    validateStatus,
    filter,
    propagationFilter,
    headers,
    hooks
  })
}

function getHeaders (config) {
  if (!Array.isArray(config.headers)) return []

  return config.headers
    .filter(key => typeof key === 'string')
    .map(key => key.toLowerCase())
}

function getHooks (config) {
  const noop = () => {}
  const request = (config.hooks && config.hooks.request) || noop

  return { request }
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
