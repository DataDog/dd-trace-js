'use strict'

const uniq = require('lodash.uniq')
const analyticsSampler = require('../../analytics_sampler')
const FORMAT_HTTP_HEADERS = require('opentracing').FORMAT_HTTP_HEADERS
const log = require('../../log')
const tags = require('../../../../../ext/tags')
const types = require('../../../../../ext/types')
const kinds = require('../../../../../ext/kinds')
const urlFilter = require('./urlfilter')

const WEB = types.WEB
const SERVER = kinds.SERVER
const RESOURCE_NAME = tags.RESOURCE_NAME
const SERVICE_NAME = tags.SERVICE_NAME
const SPAN_TYPE = tags.SPAN_TYPE
const SPAN_KIND = tags.SPAN_KIND
const ERROR = tags.ERROR
const HTTP_METHOD = tags.HTTP_METHOD
const HTTP_URL = tags.HTTP_URL
const HTTP_STATUS_CODE = tags.HTTP_STATUS_CODE
const HTTP_ROUTE = tags.HTTP_ROUTE
const HTTP_REQUEST_HEADERS = tags.HTTP_REQUEST_HEADERS
const HTTP_RESPONSE_HEADERS = tags.HTTP_RESPONSE_HEADERS

const HTTP2_HEADER_AUTHORITY = ':authority'
const HTTP2_HEADER_SCHEME = ':scheme'
const HTTP2_HEADER_PATH = ':path'

const web = {
  // Ensure the configuration has the correct structure and defaults.
  normalizeConfig (config) {
    config = config.server || config

    const headers = getHeadersToRecord(config)
    const validateStatus = getStatusValidator(config)
    const hooks = getHooks(config)
    const filter = urlFilter.getFilter(config)
    const middleware = getMiddlewareSetting(config)

    return Object.assign({}, config, {
      headers,
      validateStatus,
      hooks,
      filter,
      middleware
    })
  },

  // Start a span and activate a scope for a request.
  instrument (tracer, config, req, res, name, callback) {
    this.patch(req)

    const span = startSpan(tracer, config, req, res, name)

    // TODO: replace this with a REFERENCE_NOOP after we split http/express/etc
    if (!config.filter(req.url)) {
      span.context()._traceFlags.sampled = false
    }

    if (config.service) {
      span.setTag(SERVICE_NAME, config.service)
    }

    analyticsSampler.sample(span, config.analytics, true)

    if (!req._datadog.instrumented) {
      wrapEnd(req)
      wrapEvents(req)

      req._datadog.instrumented = true
    }

    return callback && tracer.scope().activate(span, () => callback(span))
  },

  // Reactivate the request scope in case it was changed by a middleware.
  reactivate (req, fn) {
    return reactivate(req, fn)
  },

  // Add a route segment that will be used for the resource name.
  enterRoute (req, path) {
    if (typeof path === 'string') {
      req._datadog.paths.push(path)
    }
  },

  // Remove the current route segment.
  exitRoute (req) {
    req._datadog.paths.pop()
  },

  // Start a new middleware span and activate a new scope with the span.
  wrapMiddleware (req, middleware, name, fn) {
    if (!this.active(req)) return fn()

    const tracer = req._datadog.tracer
    const childOf = this.active(req)

    if (req._datadog.config.middleware === false) return this.bindAndWrapMiddlewareErrors(fn, req, tracer, childOf)

    const span = tracer.startSpan(name, { childOf })

    span.addTags({
      [RESOURCE_NAME]: middleware._name || middleware.name || '<anonymous>'
    })

    req._datadog.middleware.push(span)

    return tracer.scope().activate(span, fn)
  },

  // catch errors and apply to active span
  bindAndWrapMiddlewareErrors (fn, req, tracer, activeSpan) {
    try {
      return tracer.scope().bind(fn, activeSpan).apply(this, arguments)
    } catch (e) {
      web.addError(req, e) // TODO: remove when error formatting is moved to Span
      throw e
    }
  },

  // Finish the active middleware span.
  finish (req, error) {
    if (!this.active(req)) return

    const span = req._datadog.middleware.pop()

    if (span) {
      if (error) {
        span.addTags({
          'error.type': error.name,
          'error.msg': error.message,
          'error.stack': error.stack
        })
      }

      span.finish()
    }
  },

  // Register a callback to run before res.end() is called.
  beforeEnd (req, callback) {
    req._datadog.beforeEnd.push(callback)
  },

  // Prepare the request for instrumentation.
  patch (req) {
    if (req._datadog) return

    if (req.stream && req.stream._datadog) {
      req._datadog = req.stream._datadog
      return
    }

    req._datadog = {
      span: null,
      paths: [],
      middleware: [],
      beforeEnd: [],
      config: {}
    }
  },

  // Return the request root span.
  root (req) {
    return req._datadog ? req._datadog.span : null
  },

  // Return the active span.
  active (req) {
    if (!req._datadog) return null
    if (req._datadog.middleware.length === 0) return req._datadog.span || null

    return req._datadog.middleware.slice(-1)[0]
  },

  // Extract the parent span from the headers and start a new span as its child
  startChildSpan (tracer, name, headers) {
    const childOf = tracer.extract(FORMAT_HTTP_HEADERS, headers)
    const span = tracer.startSpan(name, { childOf })

    return span
  },

  // Validate a request's status code and then add error tags if necessary
  addStatusError (req, statusCode) {
    const span = req._datadog.span
    const error = req._datadog.error

    if (!req._datadog.config.validateStatus(statusCode)) {
      span.setTag(ERROR, error || true)
    }
  },

  // Add an error to the request
  addError (req, error) {
    if (error instanceof Error) {
      req._datadog.error = req._datadog.error || error
    }
  }
}

function startSpan (tracer, config, req, res, name) {
  req._datadog.config = config

  let span

  if (req._datadog.span) {
    req._datadog.span.context()._name = name
    span = req._datadog.span
  } else {
    span = web.startChildSpan(tracer, name, req.headers)
  }

  configureDatadogObject(tracer, span, req, res)

  return span
}

function configureDatadogObject (tracer, span, req, res) {
  const ddObj = req._datadog
  ddObj.tracer = tracer
  ddObj.span = span
  ddObj.res = res
}

function finish (req, res) {
  if (req._datadog.finished && !req.stream) return

  addRequestTags(req)
  addResponseTags(req)

  req._datadog.config.hooks.request(req._datadog.span, req, res)
  addResourceTag(req)

  req._datadog.span.finish()
  req._datadog.finished = true
}

function finishMiddleware (req, res) {
  if (req._datadog.finished) return

  let span

  while ((span = req._datadog.middleware.pop())) {
    span.finish()
  }
}

function wrapEnd (req) {
  const scope = req._datadog.tracer.scope()
  const res = req._datadog.res
  const end = res.end

  res.writeHead = wrapWriteHead(req)

  res._datadog_end = function () {
    for (const beforeEnd of req._datadog.beforeEnd) {
      beforeEnd()
    }

    finishMiddleware(req, res)

    const returnValue = end.apply(res, arguments)

    finish(req, res)

    return returnValue
  }

  Object.defineProperty(res, 'end', {
    configurable: true,
    get () {
      return this._datadog_end
    },
    set (value) {
      this._datadog_end = scope.bind(value, req._datadog.span)
    }
  })
}

function wrapWriteHead (req) {
  const res = req._datadog.res
  const writeHead = res.writeHead

  return function (statusCode, statusMessage, headers) {
    headers = typeof statusMessage === 'string' ? headers : statusMessage
    headers = Object.assign(res.getHeaders(), headers)

    if (req.method.toLowerCase() === 'options' && isOriginAllowed(req, headers)) {
      addAllowHeaders(req, headers)
    }

    return writeHead.apply(this, arguments)
  }
}

function addAllowHeaders (req, headers) {
  const res = req._datadog.res
  const allowHeaders = splitHeader(headers['access-control-allow-headers'])
  const requestHeaders = splitHeader(req.headers['access-control-request-headers'])
  const contextHeaders = [
    'x-datadog-origin',
    'x-datadog-parent-id',
    'x-datadog-sampled',
    'x-datadog-sampling-priority',
    'x-datadog-trace-id'
  ]

  for (const header of contextHeaders) {
    if (~requestHeaders.indexOf(header)) {
      allowHeaders.push(header)
    }
  }

  if (allowHeaders.length > 0) {
    res.setHeader('access-control-allow-headers', uniq(allowHeaders).join(','))
  }
}

function isOriginAllowed (req, headers) {
  const origin = req.headers['origin']
  const allowOrigin = headers['access-control-allow-origin']

  return origin && (allowOrigin === '*' || allowOrigin === origin)
}

function splitHeader (str) {
  return typeof str === 'string' ? str.split(/\s*,\s*/) : []
}

function wrapEvents (req) {
  const scope = req._datadog.tracer.scope()
  const res = req._datadog.res

  scope.bind(res, req._datadog.span)
}

function reactivate (req, fn) {
  return req._datadog
    ? req._datadog.tracer.scope().activate(req._datadog.span, fn)
    : fn()
}

function addRequestTags (req) {
  const url = extractURL(req)
  const span = req._datadog.span

  span.addTags({
    [HTTP_URL]: url.split('?')[0],
    [HTTP_METHOD]: req.method,
    [SPAN_KIND]: SERVER,
    [SPAN_TYPE]: WEB
  })

  addHeaders(req)
}

function addResponseTags (req) {
  const span = req._datadog.span
  const res = req._datadog.res

  if (req._datadog.paths.length > 0) {
    span.setTag(HTTP_ROUTE, req._datadog.paths.join(''))
  }

  span.addTags({
    [HTTP_STATUS_CODE]: res.statusCode
  })

  web.addStatusError(req, res.statusCode)
}

function addResourceTag (req) {
  const span = req._datadog.span
  const tags = span.context()._tags

  if (tags['resource.name']) return

  const resource = [req.method, tags[HTTP_ROUTE]]
    .filter(val => val)
    .join(' ')

  span.setTag(RESOURCE_NAME, resource)
}

function addHeaders (req) {
  const span = req._datadog.span

  req._datadog.config.headers.forEach(key => {
    const reqHeader = req.headers[key]
    const resHeader = req._datadog.res.getHeader(key)

    if (reqHeader) {
      span.setTag(`${HTTP_REQUEST_HEADERS}.${key}`, reqHeader)
    }

    if (resHeader) {
      span.setTag(`${HTTP_RESPONSE_HEADERS}.${key}`, resHeader)
    }
  })
}

function extractURL (req) {
  const headers = req.headers

  if (req.stream) {
    return `${headers[HTTP2_HEADER_SCHEME]}://${headers[HTTP2_HEADER_AUTHORITY]}${headers[HTTP2_HEADER_PATH]}`
  } else {
    const protocol = getProtocol(req)
    return `${protocol}://${req.headers['host']}${req.originalUrl || req.url}`
  }
}

function getProtocol (req) {
  if (req.socket && req.socket.encrypted) return 'https'
  if (req.connection && req.connection.encrypted) return 'https'

  return 'http'
}

function getHeadersToRecord (config) {
  if (Array.isArray(config.headers)) {
    try {
      return config.headers.map(key => key.toLowerCase())
    } catch (err) {
      log.error(err)
    }
  } else if (config.hasOwnProperty('headers')) {
    log.error('Expected `headers` to be an array of strings.')
  }
  return []
}

function getStatusValidator (config) {
  if (typeof config.validateStatus === 'function') {
    return config.validateStatus
  } else if (config.hasOwnProperty('validateStatus')) {
    log.error('Expected `validateStatus` to be a function.')
  }
  return code => code < 500
}

function getHooks (config) {
  const noop = () => {}
  const request = (config.hooks && config.hooks.request) || noop

  return { request }
}

function getMiddlewareSetting (config) {
  if (config && typeof config.middleware === 'boolean') {
    return config.middleware
  } else if (config && config.hasOwnProperty('middleware')) {
    log.error('Expected `middleware` to be a boolean.')
  }

  return true
}

module.exports = web
