'use strict'

const uniq = require('../../datadog-core/src/utils/src/uniq')
const log = require('../../dd-trace/src/log')
const tags = require('../../../ext/tags')
const types = require('../../../ext/types')
const kinds = require('../../../ext/kinds')
const urlFilter = require('../../dd-trace/src/plugins/util/urlfilter')
const { ERROR_MESSAGE } = require('../../dd-trace/src/constants')

let extractIp

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
const HTTP_REQUEST_HEADERS = tags.HTTP_REQUEST_HEADERS
const HTTP_RESPONSE_HEADERS = tags.HTTP_RESPONSE_HEADERS
const HTTP_USERAGENT = tags.HTTP_USERAGENT
const HTTP_CLIENT_IP = tags.HTTP_CLIENT_IP

const HTTP2_HEADER_AUTHORITY = ':authority'
const HTTP2_HEADER_SCHEME = ':scheme'
const HTTP2_HEADER_PATH = ':path'

const contexts = new WeakMap()
const ends = new WeakMap()

function normalizeConfig (config) {
  const headers = getHeadersToRecord(config)
  const validateStatus = getStatusValidator(config)
  const hooks = getHooks(config)
  const filter = urlFilter.getFilter(config)
  const middleware = getMiddlewareSetting(config)
  const queryStringObfuscation = getQsObfuscator(config)

  extractIp = config.clientIpEnabled && require('../../dd-trace/src/plugins/util/ip_extractor').extractIp

  return {
    ...config,
    headers,
    validateStatus,
    hooks,
    filter,
    middleware,
    queryStringObfuscation
  }
}

function setRoute (req, path) {
  const context = contexts.get(req)

  if (!context) return

  context.paths = [path]
}

function patch (req, config) {
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
    config
  }

  contexts.set(req, context)

  return context
}

function root (req) {
  const context = contexts.get(req)
  return context ? context.span : null
}

function getContext (req) {
  return contexts.get(req)
}

function addError (req, error) {
  if (error instanceof Error) {
    const context = contexts.get(req)

    if (context) {
      context.error = error
    }
  }
}

function finishSpan (context) {
  const { req, res } = context

  if (context.finished && !req.stream) return

  _addRequestTags(context)
  _addResponseTags(context)

  context.config.hooks.request(context.span, req, res)
  addResourceTag(context)

  context.span.finish()
  context.finished = true
}

function _obfuscateQs (url, config) {
  const { queryStringObfuscation } = config

  if (queryStringObfuscation === false) return url

  const i = url.indexOf('?')
  if (i === -1) return url

  const path = url.slice(0, i)
  if (queryStringObfuscation === true) return path

  let qs = url.slice(i + 1)

  qs = qs.replace(queryStringObfuscation, '<redacted>')

  return `${path}?${qs}`
}

function _addRequestTags (context) {
  const { req, span, inferredProxySpan } = context
  const url = extractURL(req)

  span.addTags({
    [HTTP_URL]: _obfuscateQs(url, context.config),
    [HTTP_METHOD]: req.method,
    [SPAN_KIND]: SERVER,
    [SPAN_TYPE]: WEB,
    [HTTP_USERAGENT]: req.headers['user-agent']
  })

  // if client ip has already been set by appsec, no need to run it again
  if (extractIp && !span.context()._tags.hasOwnProperty(HTTP_CLIENT_IP)) {
    const clientIp = extractIp(context.config, req)

    if (clientIp) {
      span.setTag(HTTP_CLIENT_IP, clientIp)
      inferredProxySpan?.setTag(HTTP_CLIENT_IP, clientIp)
    }
  }

  addHeaders(context)
}

function _addResponseTags (context) {
  const { req, res, paths, span, inferredProxySpan } = context

  const route = paths.join('')
  if (route) {
    span.setTag(HTTP_ROUTE, route)
  }

  span.addTags({
    [HTTP_STATUS_CODE]: res.statusCode
  })
  inferredProxySpan?.addTags({
    [HTTP_STATUS_CODE]: res.statusCode
  })

  addStatusError(req, res.statusCode)
}

function addStatusError (req, statusCode) {
  const context = contexts.get(req)
  const { span, inferredProxySpan, error } = context

  const spanHasExistingError = span.context()._tags.error || span.context()._tags[ERROR_MESSAGE]
  const inferredSpanContext = inferredProxySpan?.context()
  const inferredSpanHasExistingError = inferredSpanContext?._tags.error || inferredSpanContext?._tags[ERROR_MESSAGE]

  const isValidStatusCode = context.config.validateStatus(statusCode)

  if (!spanHasExistingError && !isValidStatusCode) {
    span.setTag(ERROR, error || true)
  }

  if (inferredProxySpan && !inferredSpanHasExistingError && !isValidStatusCode) {
    inferredProxySpan.setTag(ERROR, error || true)
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
    'x-datadog-trace-id',
    'x-datadog-tags'
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

function reactivate (req, fn) {
  const context = contexts.get(req)

  return context
    ? context.tracer.scope().activate(context.span, fn)
    : fn()
}

function addResourceTag (context) {
  const { req, span } = context
  const tags = span.context()._tags

  if (tags['resource.name']) return

  const resource = [req.method, tags[HTTP_ROUTE]]
    .filter(Boolean)
    .join(' ')

  span.setTag(RESOURCE_NAME, resource)
}

function addHeaders (context) {
  const { req, res, config, span, inferredProxySpan } = context

  config.headers.forEach(([key, tag]) => {
    const reqHeader = req.headers[key]
    const resHeader = res.getHeader(key)

    if (reqHeader) {
      span.setTag(tag || `${HTTP_REQUEST_HEADERS}.${key}`, reqHeader)
      inferredProxySpan?.setTag(tag || `${HTTP_REQUEST_HEADERS}.${key}`, reqHeader)
    }

    if (resHeader) {
      span.setTag(tag || `${HTTP_RESPONSE_HEADERS}.${key}`, resHeader)
      inferredProxySpan?.setTag(tag || `${HTTP_RESPONSE_HEADERS}.${key}`, resHeader)
    }
  })
}

function extractURL (req) {
  const headers = req.headers

  if (req.stream) {
    return `${headers[HTTP2_HEADER_SCHEME]}://${headers[HTTP2_HEADER_AUTHORITY]}${headers[HTTP2_HEADER_PATH]}`
  }
  const protocol = getProtocol(req)
  return `${protocol}://${req.headers.host}${req.originalUrl || req.url}`
}

function getProtocol (req) {
  if (req.socket && req.socket.encrypted) return 'https'
  if (req.connection && req.connection.encrypted) return 'https'

  return 'http'
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

function getStatusValidator (config) {
  if (typeof config.validateStatus === 'function') {
    return config.validateStatus
  } else if (config.hasOwnProperty('validateStatus')) {
    log.error('Expected `validateStatus` to be a function.')
  }
  return code => code < 500
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

module.exports = {
  normalizeConfig,
  setRoute,
  patch,
  root,
  getContext,
  addError,
  finishSpan,
  _addRequestTags,
  addAllowHeaders,
  isOriginAllowed,
  reactivate,
  contexts,
  ends,
}
