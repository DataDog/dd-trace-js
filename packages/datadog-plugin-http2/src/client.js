'use strict'

const { storage } = require('../../datadog-core')
const ClientPlugin = require('../../dd-trace/src/plugins/client')

const URL = require('url').URL
const log = require('../../dd-trace/src/log')
const tags = require('../../../ext/tags')
const kinds = require('../../../ext/kinds')
const formats = require('../../../ext/formats')
const { COMPONENT, CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const urlFilter = require('../../dd-trace/src/plugins/util/urlfilter')

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

class Http2ClientPlugin extends ClientPlugin {
  static id = 'http2'
  static prefix = 'apm:http2:client:request'

  bindStart (message) {
    const { authority, options, headers = {} } = message
    const sessionDetails = extractSessionDetails(authority, options)
    const path = headers[HTTP2_HEADER_PATH] || '/'
    const pathname = path.split(/[?#]/)[0]
    const method = headers[HTTP2_HEADER_METHOD] || HTTP2_METHOD_GET
    const uri = `${sessionDetails.protocol}//${sessionDetails.host}:${sessionDetails.port}${pathname}`
    const allowed = this.config.filter(uri)

    const store = storage('legacy').getStore()
    const childOf = store && allowed ? store.span : null
    const span = this.startSpan(this.operationName(), {
      childOf,
      integrationName: this.constructor.id,
      meta: {
        [COMPONENT]: this.constructor.id,
        [SPAN_KIND]: CLIENT,
        'service.name': this.serviceName({ pluginConfig: this.config, sessionDetails }),
        'resource.name': method,
        'span.type': 'http',
        'http.method': method,
        'http.url': uri,
        'out.host': sessionDetails.host
      },
      metrics: {
        [CLIENT_PORT_KEY]: Number.parseInt(sessionDetails.port)
      }
    }, false)

    // TODO: Figure out a better way to do this for any span.
    if (!allowed) {
      span._spanContext._trace.record = false
    }

    addHeaderTags(span, headers, HTTP_REQUEST_HEADERS, this.config)

    if (!hasAmazonSignature(headers, path)) {
      this.tracer.inject(span, HTTP_HEADERS, headers)
    }

    message.parentStore = store
    message.currentStore = { ...store, span }

    return message.currentStore
  }

  bindAsyncStart (ctx) {
    const { eventName, eventData, currentStore, parentStore } = ctx

    // Plugin wasn't enabled when the request started.
    if (!currentStore) return storage('legacy').getStore()

    switch (eventName) {
      case 'response':
        this._onResponse(currentStore, eventData)
        return parentStore
      case 'error':
        this._onError(currentStore, eventData, ctx)
        return parentStore
      case 'close':
        this._onClose(ctx)
        return parentStore
    }

    return storage('legacy').getStore()
  }

  configure (config) {
    return super.configure(normalizeConfig(config))
  }

  _onResponse (store, headers) {
    const status = headers && headers[HTTP2_HEADER_STATUS]

    store.span.setTag(HTTP_STATUS_CODE, status)

    if (!this.config.validateStatus(status)) {
      storage('legacy').run(store, () => this.addError())
    }

    addHeaderTags(store.span, headers, HTTP_RESPONSE_HEADERS, this.config)
  }

  _onError ({ span }, error, ctx) {
    span.setTag('error', error)
    super.finish(ctx)
  }

  _onClose (ctx) {
    super.finish(ctx)
  }
}

function extractSessionDetails (authority, options) {
  if (typeof authority === 'string') {
    authority = new URL(authority)
  }

  const protocol = authority.protocol || options.protocol || 'https:'
  let port = authority.port === ''
    ? authority.protocol === 'http:' ? '80' : '443'
    : String(authority.port)
  let host = authority.hostname || authority.host || 'localhost'

  if (protocol === 'https:' && options) {
    port = options.port || port
    host = options.host || host
  }

  return { protocol, port, host }
}

function hasAmazonSignature (headers, path) {
  if (path?.toLowerCase().includes('x-amz-signature=')) {
    return true
  }

  if (headers) {
    for (const [key, value] of Object.entries(headers)) {
      const lowerCaseKey = key.toLowerCase()
      if (lowerCaseKey === 'x-amz-signature' && value) {
        return true
      }
      if (lowerCaseKey === 'authorization' && value) {
        const authorization = Array.isArray(value) ? value : [value]
        if (authorization.some((val) => val.startsWith('AWS4-HMAC-SHA256'))) {
          return true
        }
      }
    }
  }

  return false
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
  const filter = getFilter(config)
  const headers = getHeaders(config)

  return {
    ...config,
    validateStatus,
    filter,
    headers
  }
}

function getFilter (config) {
  config = { ...config, blocklist: config.blocklist || [] }

  return urlFilter.getFilter(config)
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
