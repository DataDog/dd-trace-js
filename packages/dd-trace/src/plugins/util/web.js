'use strict'

const uniq = require('lodash.uniq')
const analyticsSampler = require('../../analytics_sampler')
const FORMAT_HTTP_HEADERS = require('opentracing').FORMAT_HTTP_HEADERS
const log = require('../../log')
const tags = require('../../../../../ext/tags')
const types = require('../../../../../ext/types')
const kinds = require('../../../../../ext/kinds')
const urlFilter = require('./urlfilter')
const { incomingHttpRequestEnd } = require('../../appsec/gateway/channels')

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
const HTTP_USERAGENT = tags.HTTP_USERAGENT
const MANUAL_DROP = tags.MANUAL_DROP

const HTTP2_HEADER_AUTHORITY = ':authority'
const HTTP2_HEADER_SCHEME = ':scheme'
const HTTP2_HEADER_PATH = ':path'

const contexts = new WeakMap()
const ends = new WeakMap()

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

  setFramework (req, name, config) {
    const context = this.patch(req)
    const span = context.span

    if (!span) return

    span.context()._name = `${name}.request`

    web.setConfig(req, config)
  },

  setConfig (req, config) {
    const context = contexts.get(req)
    const span = context.span

    context.config = config

    if (!config.filter(req.url)) {
      span.setTag(MANUAL_DROP, true)
      span.context()._trace.isRecording = false
    }

    if (config.service) {
      span.setTag(SERVICE_NAME, config.service)
    }

    analyticsSampler.sample(span, config.measured, true)
  },

  startSpan (tracer, config, req, res, name) {
    const context = this.patch(req)

    let span

    if (context.span) {
      context.span.context()._name = name
      span = context.span
    } else {
      span = web.startChildSpan(tracer, name, req.headers)
    }

    context.tracer = tracer
    context.span = span
    context.res = res

    this.setConfig(req, config)

    return span
  },
  wrap (req) {
    const context = contexts.get(req)
    if (!context.instrumented) {
      this.wrapEnd(context)
      this.wrapEvents(context)
      context.instrumented = true
    }
  },
  // Start a span and activate a scope for a request.
  instrument (tracer, config, req, res, name, callback) {
    const span = this.startSpan(tracer, config, req, res, name)

    this.wrap(req)

    return callback && tracer.scope().activate(span, () => callback(span))
  },

  // Reactivate the request scope in case it was changed by a middleware.
  reactivate (req, fn) {
    return reactivate(req, fn)
  },

  // Add a route segment that will be used for the resource name.
  enterRoute (req, path) {
    if (typeof path === 'string') {
      contexts.get(req).paths.push(path)
    }
  },

  setRoute (req, path) {
    const context = contexts.get(req)

    if (!context) return

    context.paths = [path]
  },

  // Remove the current route segment.
  exitRoute (req) {
    contexts.get(req).paths.pop()
  },

  // Start a new middleware span and activate a new scope with the span.
  wrapMiddleware (req, middleware, name, fn) {
    if (!this.active(req)) return fn()

    const context = contexts.get(req)
    const tracer = context.tracer
    const childOf = this.active(req)
    const config = context.config

    if (config.middleware === false) return this.bindAndWrapMiddlewareErrors(fn, req, tracer, childOf)

    const span = tracer.startSpan(name, { childOf })

    analyticsSampler.sample(span, config.measured)

    span.addTags({
      [RESOURCE_NAME]: middleware._name || middleware.name || '<anonymous>'
    })

    context.middleware.push(span)

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

    const context = contexts.get(req)
    const span = context.middleware.pop()

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
    contexts.get(req).beforeEnd.push(callback)
  },

  // Prepare the request for instrumentation.
  patch (req) {
    let context = contexts.get(req)

    if (context) return context

    context = req.stream && contexts.get(req.stream)

    if (context) {
      contexts.set(req, context)
      return context
    }

    context = {
      req,
      span: null,
      paths: [],
      middleware: [],
      beforeEnd: [],
      config: {}
    }

    contexts.set(req, context)

    return context
  },

  // Return the request root span.
  root (req) {
    const context = contexts.get(req)
    return context ? context.span : null
  },

  // Return the active span.
  active (req) {
    const context = contexts.get(req)

    if (!context) return null
    if (context.middleware.length === 0) return context.span || null

    return context.middleware.slice(-1)[0]
  },

  // Extract the parent span from the headers and start a new span as its child
  startChildSpan (tracer, name, headers) {
    const childOf = tracer.scope().active() || tracer.extract(FORMAT_HTTP_HEADERS, headers)

    const span = tracer.startSpan(name, { childOf })

    return span
  },

  // Validate a request's status code and then add error tags if necessary
  addStatusError (req, statusCode) {
    const context = contexts.get(req)
    const span = context.span
    const error = context.error
    const hasMiddlewareError = span.context()._tags['error'] || span.context()._tags['error.msg']

    if (!hasMiddlewareError && !context.config.validateStatus(statusCode)) {
      span.setTag(ERROR, error || true)
    }
  },

  // Add an error to the request
  addError (req, error) {
    if (error instanceof Error) {
      const context = contexts.get(req)
      context.error = context.error || error
    }
  },

  finishMiddleware (context) {
    if (context.finished) return

    let span

    while ((span = context.middleware.pop())) {
      span.finish()
    }
  },

  finishSpan (context) {
    const { req, res } = context

    if (context.finished && !req.stream) return

    addRequestTags(context)
    addResponseTags(context)

    context.config.hooks.request(context.span, req, res)
    addResourceTag(context)

    context.span.finish()
    context.finished = true
  },
  wrapWriteHead (context) {
    const { req, res } = context
    const writeHead = res.writeHead

    return function (statusCode, statusMessage, headers) {
      headers = typeof statusMessage === 'string' ? headers : statusMessage
      headers = Object.assign(res.getHeaders(), headers)

      if (req.method.toLowerCase() === 'options' && isOriginAllowed(req, headers)) {
        addAllowHeaders(req, res, headers)
      }

      return writeHead.apply(this, arguments)
    }
  },
  getContext (req) {
    return contexts.get(req)
  },
  wrapRes (context, req, res, end) {
    return function () {
      for (const beforeEnd of context.beforeEnd) {
        beforeEnd()
      }

      web.finishMiddleware(context)

      if (incomingHttpRequestEnd.hasSubscribers) {
        incomingHttpRequestEnd.publish({ req, res })
      }

      const returnValue = end.apply(res, arguments)

      web.finishSpan(context)

      return returnValue
    }
  },
  wrapEnd (context) {
    const scope = context.tracer.scope()
    const req = context.req
    const res = context.res
    const end = res.end

    res.writeHead = web.wrapWriteHead(context)

    ends.set(res, this.wrapRes(context, req, res, end))

    Object.defineProperty(res, 'end', {
      configurable: true,
      get () {
        return ends.get(this)
      },
      set (value) {
        ends.set(this, scope.bind(value, context.span))
      }
    })
  },
  wrapEvents (context) {
    const scope = context.tracer.scope()
    const res = context.res

    scope.bind(res, context.span)
  }
}

function addAllowHeaders (req, res, headers) {
  const allowHeaders = splitHeader(headers['access-control-allow-headers'])
  const requestHeaders = splitHeader(req.headers['access-control-request-headers'])
  const contextHeaders = [
    'x-datadog-origin',
    'x-datadog-parent-id',
    'x-datadog-sampled', // Deprecated, but still accept it in case it's sent.
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

function reactivate (req, fn) {
  const context = contexts.get(req)

  return context
    ? context.tracer.scope().activate(context.span, fn)
    : fn()
}

function addRequestTags (context) {
  const { req, span } = context
  const url = extractURL(req)

  span.addTags({
    [HTTP_URL]: url,
    [HTTP_METHOD]: req.method,
    [SPAN_KIND]: SERVER,
    [SPAN_TYPE]: WEB,
    [HTTP_USERAGENT]: req.headers['user-agent']
  })

  addHeaders(context)
}

function addResponseTags (context) {
  const { req, res, paths, span } = context

  if (paths.length > 0) {
    span.setTag(HTTP_ROUTE, paths.join(''))
  }

  span.addTags({
    [HTTP_STATUS_CODE]: res.statusCode
  })

  web.addStatusError(req, res.statusCode)
}

function addResourceTag (context) {
  const { req, span } = context
  const tags = span.context()._tags

  if (tags['resource.name']) return

  const resource = [req.method, tags[HTTP_ROUTE]]
    .filter(val => val)
    .join(' ')

  span.setTag(RESOURCE_NAME, resource)
}

function addHeaders (context) {
  const { req, res, config, span } = context

  config.headers.forEach(key => {
    const reqHeader = req.headers[key]
    const resHeader = res.getHeader(key)

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
