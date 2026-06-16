'use strict'

const uniq = require('../../../../datadog-core/src/utils/src/uniq')
const analyticsSampler = require('../../analytics_sampler')
const FORMAT_HTTP_HEADERS = 'http_headers'
const log = require('../../log')
const tags = require('../../../../../ext/tags')
const types = require('../../../../../ext/types')
const kinds = require('../../../../../ext/kinds')
const { ERROR_MESSAGE } = require('../../constants')
const TracingPlugin = require('../tracing')
const { storage } = require('../../../../datadog-core')
const legacyStorage = storage('legacy')
const urlFilter = require('./urlfilter')
const { createInferredProxySpan, finishInferredProxySpan } = require('./inferred_proxy')
const { extractURL, obfuscateQs, calculateHttpEndpoint } = require('./url')

const WEB = types.WEB
const SERVER = kinds.SERVER
const RESOURCE_NAME = tags.RESOURCE_NAME
const SPAN_TYPE = tags.SPAN_TYPE
const SPAN_KIND = tags.SPAN_KIND
const ERROR = tags.ERROR
const HTTP_METHOD = tags.HTTP_METHOD
const HTTP_URL = tags.HTTP_URL
const HTTP_STATUS_CODE = tags.HTTP_STATUS_CODE
const HTTP_ROUTE = tags.HTTP_ROUTE
const HTTP_ENDPOINT = tags.HTTP_ENDPOINT
const HTTP_REQUEST_HEADERS = tags.HTTP_REQUEST_HEADERS
const HTTP_RESPONSE_HEADERS = tags.HTTP_RESPONSE_HEADERS
const HTTP_USERAGENT = tags.HTTP_USERAGENT
const HTTP_CLIENT_IP = tags.HTTP_CLIENT_IP
const MANUAL_DROP = tags.MANUAL_DROP

const contexts = new WeakMap()

// TODO: change this to no longer rely on creating a dummy plugin to be able to access startSpan
function createWebPlugin (tracer, config = {}) {
  const plugin = new TracingPlugin(tracer, tracer._config)
  plugin.component = 'web'
  plugin.config = config
  return plugin
}

function startSpanHelper (tracer, name, options, traceCtx, config = {}) {
  if (!web.plugin) {
    web.plugin = createWebPlugin(tracer, config)
  }

  return web.plugin.startSpan(name, { ...options, tracer, config }, traceCtx)
}

const web = {
  TYPE: WEB,
  /** @type {TracingPlugin | null} */
  plugin: null,

  // Ensure the configuration has the correct structure and defaults.
  normalizeConfig (config) {
    const headers = getHeadersToRecord(config)
    const validateStatus = getStatusValidator(config)
    const hooks = getHooks(config)
    const filter = urlFilter.getFilter(config)
    const middleware = getMiddlewareSetting(config)
    const queryStringObfuscation = getQsObfuscator(config)

    const extractIp = config.clientIpEnabled
      ? require('./ip_extractor').extractIp
      : undefined

    return {
      ...config,
      headers,
      validateStatus,
      hooks,
      filter,
      middleware,
      queryStringObfuscation,
      extractIp,
    }
  },

  setFramework (req, name, config, frameworkVersion) {
    const context = this.patch(req)
    const span = context.span

    if (!span) return

    span.context()._name = `${name}.request`
    span.context().setTag('component', name)
    span._integrationName = name

    // Optional: record the framework's major version (e.g. for route-syntax dialect decisions).
    if (frameworkVersion !== undefined) context.frameworkVersion = frameworkVersion

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
      web.plugin.setServiceName(span, config.service)
    }

    analyticsSampler.sample(span, config.measured, true)
  },

  startSpan (tracer, config, req, res, name, traceCtx) {
    const context = this.patch(req)

    let span

    if (context.span) {
      context.span.context()._name = name
      span = context.span
    } else {
      span = web.startServerlessSpanWithInferredProxy(tracer, config, name, req, traceCtx)
    }

    context.tracer = tracer
    context.span = span
    context.res = res

    this.setConfig(req, config)
    addRequestTags(context, this.TYPE)

    return span
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
      config: {},
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

    return context.middleware.at(-1)
  },

  startServerlessSpanWithInferredProxy (tracer, config, name, req, traceCtx) {
    const headers = req.headers
    const reqCtx = contexts.get(req)
    const store = legacyStorage.getStore()
    const pubsubSpan = store?.span?._name === 'pubsub.push.receive' ? store.span : null

    let childOf = pubsubSpan || tracer.extract(FORMAT_HTTP_HEADERS, headers)

    // we may have headers signaling a router proxy span should be created (such as for AWS API Gateway)
    if (tracer._config?.inferredProxyServicesEnabled) {
      const proxySpan = createInferredProxySpan(headers, childOf, tracer, reqCtx, traceCtx, config, startSpanHelper)
      if (proxySpan) {
        childOf = proxySpan
      }
    }

    return startSpanHelper(tracer, name, { childOf }, traceCtx, config)
  },

  // Validate a request's status code and then add error tags if necessary
  addStatusError (req, statusCode) {
    const context = contexts.get(req)
    const { span, inferredProxySpan, error } = context

    const spanContext = span.context()
    const spanHasExistingError = spanContext.getTag('error') || spanContext.getTag(ERROR_MESSAGE)
    const inferredSpanContext = inferredProxySpan?.context()
    const inferredSpanHasExistingError = inferredSpanContext?.getTag('error') ||
      inferredSpanContext?.getTag(ERROR_MESSAGE)

    const isValidStatusCode = context.config.validateStatus(statusCode)

    if (!spanHasExistingError && !isValidStatusCode) {
      span.setTag(ERROR, error || true)
    }

    if (inferredProxySpan && !inferredSpanHasExistingError && !isValidStatusCode) {
      inferredProxySpan.setTag(ERROR, error || true)
    }
  },

  // Add an error to the request
  addError (req, error) {
    if (error instanceof Error) {
      const context = contexts.get(req)

      if (context) {
        context.error = error
      }
    }
  },

  finishMiddleware (context) {
    if (context.finished) return

    let span

    while ((span = context.middleware.pop())) {
      span.finish()
    }
  },

  finishSpan (context, spanType) {
    const { req, res } = context

    if (context.finished && !req.stream) return

    // `addRequestTags` is idempotent: in the normal HTTP path it ran during
    // `web.startSpan`. Serverless callers (e.g. Azure Functions) skip
    // `web.startSpan` and rely on this call to do the request-side work.
    addRequestTags(context, spanType)
    // Configured-header tagging runs at finish time. Framework plugins
    // (connect, express, ...) install their own config via `setFramework`
    // after `web.startSpan` has already locked the http-plugin config in;
    // tagging earlier would use the http-plugin's `headers` list and drop
    // the framework's.
    addRequestHeaders(context)
    addResponseTags(context)

    context.config.hooks.request(context.span, req, res)
    addResourceTag(context)

    context.span.finish()
    context.finished = true
  },

  finishAll (context, spanType) {
    for (const beforeEnd of context.beforeEnd) {
      beforeEnd()
    }

    web.finishMiddleware(context)

    web.finishSpan(context, spanType)

    finishInferredProxySpan(context)
  },

  wrapWriteHead (context) {
    const { req, res } = context
    const writeHead = res.writeHead

    return function (statusCode, statusMessage, headers) {
      // CORS preflight tagging only matters for OPTIONS requests. Skip the
      // getHeaders() spread + isOriginAllowed work entirely for the common
      // GET / POST / etc. case. Node's http module passes `req.method`
      // through unchanged, so all standard methods are uppercase; the
      // `toLowerCase` fallback covers any non-standard caller.
      if (req.method === 'OPTIONS' || req.method.toLowerCase() === 'options') {
        headers = typeof statusMessage === 'string' ? headers : statusMessage
        headers = { ...res.getHeaders(), ...headers }

        if (isOriginAllowed(req, headers)) {
          addAllowHeaders(req, res, headers)
        }
      }

      return writeHead.apply(this, arguments)
    }
  },
  getContext (req) {
    return contexts.get(req)
  },
  setRouteOrEndpointTag (req) {
    const context = contexts.get(req)

    if (!context) return

    applyRouteOrEndpointTag(context)
  },
}

function addAllowHeaders (req, res, headers) {
  const allowHeaders = splitHeader(headers['access-control-allow-headers'])
  const requestHeaders = splitHeader(req.headers['access-control-request-headers'])
  const contextHeaders = [
    'x-datadog-origin',
    'x-datadog-parent-id',
    'x-datadog-sampled', // Deprecated, but still accept it in case it's sent.
    'x-datadog-sampling-priority',
    'x-datadog-trace-id',
    'x-datadog-tags',
  ]

  for (const header of contextHeaders) {
    if (requestHeaders.includes(header)) {
      allowHeaders.push(header)
    }
  }

  if (allowHeaders.length > 0) {
    res.setHeader('access-control-allow-headers', uniq(allowHeaders).join(','))
  }
}

function isOriginAllowed (req, headers) {
  const origin = req.headers.origin
  const allowOrigin = headers['access-control-allow-origin']

  return origin && (allowOrigin === '*' || allowOrigin === origin)
}

function splitHeader (str) {
  return typeof str === 'string' ? str.split(/\s*,\s*/) : []
}

function addRequestTags (context, spanType) {
  const { req, span, inferredProxySpan, config } = context
  const spanContext = span.context()

  // Idempotency guard. `addRequestTags` runs in `web.startSpan` for the
  // normal HTTP path and again in `web.finishSpan`; without this guard the
  // second call would re-extract the URL, re-obfuscate the query string,
  // and re-publish five `tagsUpdateCh` events with the same values. The
  // serverless path skips `startSpan` and lands here first, in which case
  // HTTP_URL is unset and the work runs normally.
  if (spanContext.hasTag(HTTP_URL)) return

  const url = extractURL(req)
  const type = spanType ?? WEB

  span.addTags({
    [HTTP_URL]: obfuscateQs(config, url),
    [HTTP_METHOD]: req.method,
    [SPAN_KIND]: SERVER,
    [SPAN_TYPE]: type,
    [HTTP_USERAGENT]: req.headers['user-agent'],
  })

  // if client ip has already been set by appsec, no need to run it again
  if (config.extractIp && !spanContext.hasTag(HTTP_CLIENT_IP)) {
    const clientIp = config.extractIp(config, req)

    if (clientIp) {
      span.setTag(HTTP_CLIENT_IP, clientIp)
      inferredProxySpan?.setTag(HTTP_CLIENT_IP, clientIp)
    }
  }

  // Datadog scan/test markers, tagged unconditionally so the API endpoint
  // reducer can keep scan/test traffic out of the API inventory.
  const endpointScan = req.headers['x-datadog-endpoint-scan']
  if (endpointScan !== undefined) {
    span.setTag(`${HTTP_REQUEST_HEADERS}.x-datadog-endpoint-scan`, endpointScan)
  }
  const securityTest = req.headers['x-datadog-security-test']
  if (securityTest !== undefined) {
    span.setTag(`${HTTP_REQUEST_HEADERS}.x-datadog-security-test`, securityTest)
  }
}

function addResponseTags (context) {
  const { req, res, inferredProxySpan, span } = context

  applyRouteOrEndpointTag(context)

  span.addTags({
    [HTTP_STATUS_CODE]: res.statusCode,
  })
  inferredProxySpan?.addTags({
    [HTTP_STATUS_CODE]: res.statusCode,
  })

  addResponseHeaders(context)

  web.addStatusError(req, res.statusCode)
}

function applyRouteOrEndpointTag (context) {
  const { paths, span, config } = context
  if (!span) return
  const spanContext = span.context()

  // AppSec calls `web.setRouteOrEndpointTag` from a pre-finish hook so the
  // route/endpoint tags are available for API Security sampling, and the
  // normal finish-time path runs this again. Either tag being present
  // means the work has already been done; paths are stable between the
  // two calls, so the second pass has nothing to add.
  if (spanContext.hasTag(HTTP_ROUTE) || spanContext.hasTag(HTTP_ENDPOINT)) return

  // Skip the `Array.prototype.join` builtin in the empty / single-segment
  // cases; `paths[0]` covers both (`undefined` is falsy for the empty case).
  const route = paths.length > 1 ? paths.join('') : paths[0]

  if (route) {
    // Use http.route from trusted framework instrumentation.
    span.setTag(HTTP_ROUTE, route)
    return
  }

  if (!config.resourceRenamingEnabled) return

  // Route is unavailable, compute http.endpoint once.
  const url = spanContext.getTag(HTTP_URL)
  const endpoint = url ? calculateHttpEndpoint(url) : '/'
  span.setTag(HTTP_ENDPOINT, endpoint)
}

function addResourceTag (context) {
  const { req, span } = context
  const spanContext = span.context()

  if (spanContext.getTag(RESOURCE_NAME)) return

  const resource = [req.method, spanContext.getTag(HTTP_ROUTE)]
    .filter(Boolean)
    .join(' ')

  span.setTag(RESOURCE_NAME, resource)
}

function addRequestHeaders (context) {
  const { req, config, span, inferredProxySpan } = context

  for (const [key, tag] of config.headers) {
    const reqHeader = req.headers[key]
    if (reqHeader) {
      const tagName = tag || `${HTTP_REQUEST_HEADERS}.${key}`
      span.setTag(tagName, reqHeader)
      inferredProxySpan?.setTag(tagName, reqHeader)
    }
  }
}

function addResponseHeaders (context) {
  const { res, config, span, inferredProxySpan } = context

  for (const [key, tag] of config.headers) {
    const resHeader = res.getHeader(key)
    if (resHeader) {
      const tagName = tag || `${HTTP_RESPONSE_HEADERS}.${key}`
      span.setTag(tagName, resHeader)
      inferredProxySpan?.setTag(tagName, resHeader)
    }
  }
}

function getHeadersToRecord (config) {
  if (Array.isArray(config.headers)) {
    try {
      return config.headers
        .map(h => h.split(':'))
        .map(([key, tag]) => [key.toLowerCase(), tag])
    } catch (err) {
      log.error('Web plugin error getting headers', err)
    }
  } else if (config.hasOwnProperty('headers')) {
    log.error('Expected `headers` to be an array of strings.')
  }
  return []
}

function isNot500ErrorCode (code) {
  return code < 500
}

function getStatusValidator (config) {
  if (typeof config.validateStatus === 'function') {
    return config.validateStatus
  } else if (config.hasOwnProperty('validateStatus')) {
    log.error('Expected `validateStatus` to be a function.')
  }
  return isNot500ErrorCode
}

const noop = () => {}

function getHooks (config) {
  const request = config.hooks?.request ?? noop

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

function getQsObfuscator (config) {
  const obfuscator = config.queryStringObfuscation

  if (typeof obfuscator === 'boolean') {
    return obfuscator
  }

  if (typeof obfuscator === 'string') {
    if (obfuscator === '') return false // disable obfuscator

    if (obfuscator === '.*') return true // optimize full redact

    try {
      return new RegExp(obfuscator, 'gi')
    } catch (err) {
      log.error('Web plugin error getting qs obfuscator', err)
    }
  }

  if (config.hasOwnProperty('queryStringObfuscation')) {
    log.error('Expected `queryStringObfuscation` to be a regex string or boolean.')
  }

  return true
}

module.exports = web
