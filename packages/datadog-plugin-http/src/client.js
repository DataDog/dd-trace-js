'use strict'

const url = require('url')
const semver = require('semver')
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

      const uri = args.uri
      const options = args.options

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

      if (!hasAmazonSignature(options)) {
        tracer.inject(span, HTTP_HEADERS, options.headers)
      }

      analyticsSampler.sample(span, config.analytics)

      callback = scope.bind(callback, childOf)

      const req = scope.bind(request, span).call(this, options, callback)
      const emit = req.emit

      req.emit = function (eventName, arg) {
        switch (eventName) {
          case 'response': {
            const res = arg

            scope.bind(res)

            span.setTag(HTTP_STATUS_CODE, res.statusCode)

            addResponseHeaders(res, span, config)

            if (!config.validateStatus(res.statusCode)) {
              span.setTag('error', 1)
            }

            res.on('end', () => finish(req, res, span, config))

            break
          }
          case 'error':
            addError(span, arg)
          case 'abort': // eslint-disable-line no-fallthrough
          case 'close': // eslint-disable-line no-fallthrough
            finish(req, null, span, config)
        }

        return emit.apply(this, arguments)
      }

      scope.bind(req)

      return req
    }
  }

  function finish (req, res, span, config) {
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

  function extractUrl (options) {
    const uri = options
    const agent = options.agent || http.globalAgent

    return typeof uri === 'string' ? uri : url.format({
      protocol: options.protocol || agent.protocol,
      hostname: options.hostname || options.host || 'localhost',
      port: options.port,
      pathname: options.path || options.pathname || '/'
    })
  }

  function normalizeArgs (inputURL, inputOptions, callback) {
    let options = normalizeURL(inputURL)

    if (typeof inputOptions === 'function') {
      callback = inputOptions
    } else if (typeof inputOptions === 'object') {
      options = Object.assign(options, inputOptions)
    }
    const uri = extractUrl(options)
    return { uri, options, callback }
  }

  function normalizeURL (inputURL) {
    let options

    if (typeof inputURL === 'string') {
      options = url.parse(inputURL)
    } else {
      options = {}
      for (const key in inputURL) {
        options[key] = inputURL[key]
      }
    }

    options.headers = options.headers || {}
    return options
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
  const blacklist = tracer._url ? [`${tracer._url.href}/v0.4/traces`] : []

  config = Object.assign({}, config, {
    blacklist: blacklist.concat(config.blacklist || [])
  })

  return urlFilter.getFilter(config)
}

function normalizeConfig (tracer, config) {
  config = config.client || config

  const validateStatus = getStatusValidator(config)
  const filter = getFilter(tracer, config)
  const headers = getHeaders(config)
  const hooks = getHooks(config)

  return Object.assign({}, config, {
    validateStatus,
    filter,
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
      if (semver.satisfies(process.version, '>=8')) {
        /**
         * In newer Node versions references internal to modules, such as `http(s).get` calling `http(s).request`, do
         * not use externally patched versions, which is why we need to also patch `get` here separately.
         */
        patch.call(this, http, 'get', tracer, config)
      }
    },
    unpatch
  },
  {
    name: 'https',
    patch: function (http, tracer, config) {
      if (config.client === false) return

      if (semver.satisfies(process.version, '>=9')) {
        patch.call(this, http, 'request', tracer, config)
        patch.call(this, http, 'get', tracer, config)
      } else {
        /**
         * Below Node v9 the `https` module invokes `http.request`, which would end up counting requests twice.
         * So rather then patch the `https` module, we ensure the `http` module is patched and we count only there.
         */
        require('http')
      }
    },
    unpatch
  }
]
