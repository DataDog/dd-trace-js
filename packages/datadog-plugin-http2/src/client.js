'use strict'

const { storage } = require('../../datadog-core')
const Plugin = require('../../dd-trace/src/plugins/plugin')

const URL = require('url').URL
const log = require('../../dd-trace/src/log')
const tags = require('../../../ext/tags')
const kinds = require('../../../ext/kinds')
const formats = require('../../../ext/formats')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')

const HTTP_HEADERS = formats.HTTP_HEADERS
const HTTP_STATUS_CODE = tags.HTTP_STATUS_CODE
const HTTP_REQUEST_HEADERS = tags.HTTP_REQUEST_HEADERS
const HTTP_RESPONSE_HEADERS = tags.HTTP_RESPONSE_HEADERS
const SPAN_KIND = tags.SPAN_KIND
const CLIENT = kinds.CLIENT

const HTTP2_HEADER_METHOD = ':method'
const HTTP2_HEADER_PATH = ':path'
const HTTP2_HEADER_STATUS = ':status'
const HTTP2_METHOD_GET = 'GET'

class Http2ClientPlugin extends Plugin {
  static get name () {
    return 'http2'
  }

  constructor (...args) {
    super(...args)

    this.addSub('apm:http2:client:request:start', ({ authority, options, headers = {} }) => {
      const sessionDetails = extractSessionDetails(authority, options)
      const path = headers[HTTP2_HEADER_PATH] || '/'
      const pathname = path.split(/[?#]/)[0]
      const method = headers[HTTP2_HEADER_METHOD] || HTTP2_METHOD_GET
      const uri = `${sessionDetails.protocol}//${sessionDetails.host}:${sessionDetails.port}${pathname}`

      const store = storage.getStore()
      const childOf = store ? store.span : store
      const span = this.tracer.startSpan('http.request', {
        childOf,
        tags: {
          [SPAN_KIND]: CLIENT,
          'service.name': getServiceName(this.tracer, this.config, sessionDetails),
          'resource.name': method,
          'span.type': 'http',
          'http.method': method,
          'http.url': uri
        }
      })

      addHeaderTags(span, headers, HTTP_REQUEST_HEADERS, this.config)

      if (!hasAmazonSignature(headers, path)) {
        this.tracer.inject(span, HTTP_HEADERS, headers)
      }

      analyticsSampler.sample(span, this.config.measured)

      this.enter(span, store)
    })

    this.addSub('apm:http2:client:response', (headers) => {
      const span = storage.getStore().span
      const status = headers && headers[HTTP2_HEADER_STATUS]

      span.setTag(HTTP_STATUS_CODE, status)

      if (!this.config.validateStatus(status)) {
        this.addError()
      }

      addHeaderTags(span, headers, HTTP_RESPONSE_HEADERS, this.config)

      span.finish()
    })

    this.addSub('apm:http2:client:request:finish', () => {
      const span = storage.getStore().span

      span.finish()
    })

    this.addSub('apm:http2:client:request:error', this.addError)
  }

  configure (config) {
    return super.configure(normalizeConfig(config))
  }
}

function extractSessionDetails (authority, options) {
  if (typeof authority === 'string') {
    authority = new URL(authority)
  }

  const protocol = authority.protocol || options.protocol || 'https:'
  let port = '' + (authority.port !== ''
    ? authority.port : (authority.protocol === 'http:' ? 80 : 443))
  let host = authority.hostname || authority.host || 'localhost'

  if (protocol === 'https:' && options) {
    port = options.port || port
    host = options.host || host
  }

  return { protocol, port, host }
}

function getFormattedHostString (host, port) {
  return [host, port].filter(val => val).join(':')
}

function getServiceName (tracer, config, sessionDetails) {
  if (config.splitByDomain) {
    return getFormattedHostString(sessionDetails.host, sessionDetails.port)
  } else if (config.service) {
    return config.service
  }

  return `${tracer._service}-http-client`
}

function hasAmazonSignature (headers, path) {
  if (headers) {
    headers = Object.keys(headers)
      .reduce((prev, next) => Object.assign(prev, {
        [next.toLowerCase()]: headers[next]
      }), {})

    if (headers['x-amz-signature']) {
      return true
    }

    if ([].concat(headers['authorization']).some(startsWith('AWS4-HMAC-SHA256'))) {
      return true
    }
  }

  return path && path.toLowerCase().indexOf('x-amz-signature=') !== -1
}

function startsWith (searchString) {
  return value => String(value).startsWith(searchString)
}

function getStatusValidator (config) {
  if (typeof config.validateStatus === 'function') {
    return config.validateStatus
  } else if (config.hasOwnProperty('validateStatus')) {
    log.error('Expected `validateStatus` to be a function.')
  }
  return code => code < 400 || code >= 500
}

function normalizeConfig (config) {
  const validateStatus = getStatusValidator(config)
  const headers = getHeaders(config)

  return Object.assign({}, config, {
    validateStatus,
    headers
  })
}

function addHeaderTags (span, headers, prefix, config) {
  if (!headers) return

  config.headers.forEach(key => {
    const value = headers[key]

    if (value) {
      span.setTag(`${prefix}.${key}`, value)
    }
  })
}

function getHeaders (config) {
  if (!Array.isArray(config.headers)) return []

  return config.headers
    .filter(key => typeof key === 'string')
    .map(key => key.toLowerCase())
}

module.exports = Http2ClientPlugin
