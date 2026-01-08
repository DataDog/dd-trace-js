'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing.js')
const tags = require('../../../ext/tags.js')
const { initWebSocketMessageCounters } = require('./util')
const { FORMAT_HTTP_HEADERS } = require('../../../ext/formats')
const log = require('../../dd-trace/src/log')

const HTTP_STATUS_CODE = tags.HTTP_STATUS_CODE

class WSServerPlugin extends TracingPlugin {
  static get id () { return 'ws' }
  static get prefix () { return 'tracing:ws:server:connect' }
  static get type () { return 'websocket' }
  static get kind () { return 'request' }

  bindStart (ctx) {
    const req = ctx.req
    log.debug('[WS-SERVER] bindStart called, url: %s', req?.url)

    const options = {}
    const headers = Object.entries(req.headers)
    options.headers = Object.fromEntries(headers)
    options.method = req.method

    const protocol = `${getRequestProtocol(req)}:`
    const host = options.headers.host
    const url = req.url
    const indexOfParam = url.indexOf('?')
    const route = indexOfParam === -1 ? url : url.slice(0, indexOfParam)
    const uri = `${protocol}//${host}${route}`

    ctx.args = { options }

    // Extract distributed tracing context from request headers
    const childOf = this.tracer.extract(FORMAT_HTTP_HEADERS, req.headers)
    log.debug('[WS-SERVER] bindStart: extracted childOf context: %s', childOf ? 'yes' : 'no')

    const service = this.serviceName({ pluginConfig: this.config })
    const span = this.startSpan(this.operationName(), {
      service,
      childOf,
      meta: {
        'span.type': 'websocket',
        'http.upgraded': 'websocket',
        'http.method': options.method,
        'http.url': uri,
        'resource.name': `${options.method} ${route}`,
        'span.kind': 'server'

      }

    }, ctx)
    ctx.span = span

    const spanId = ctx.span?._spanContext?._spanId?.toString()
    log.debug('[WS-SERVER] bindStart: span created, spanId: %s, uri: %s', spanId, uri)

    ctx.socket.spanContext = ctx.span._spanContext
    ctx.socket.spanContext.spanTags = ctx.span._spanContext._tags
    // Store the handshake span for use in message span pointers
    ctx.socket.handshakeSpan = ctx.span
    // Store the request headers for distributed tracing check
    ctx.socket.requestHeaders = req.headers

    // Initialize message counters for span pointers
    initWebSocketMessageCounters(ctx.socket)

    log.debug('[WS-SERVER] bindStart: socket context initialized, spanId: %s', spanId)
    return ctx.currentStore
  }

  bindAsyncStart (ctx) {
    const spanId = ctx.span?._spanContext?._spanId?.toString()
    log.debug('[WS-SERVER] bindAsyncStart called, spanId: %s, resStatus: %s', spanId, ctx.req?.resStatus)

    if (!ctx.span) {
      log.warn('[WS-SERVER] bindAsyncStart: ctx.span is undefined!')
      return ctx.parentStore
    }

    ctx.span.setTag(HTTP_STATUS_CODE, ctx.req.resStatus)

    return ctx.parentStore
  }

  asyncStart (ctx) {
    const spanId = ctx.span?._spanContext?._spanId?.toString()
    log.debug('[WS-SERVER] asyncStart called, spanId: %s', spanId)

    if (!ctx.span) {
      log.warn('[WS-SERVER] asyncStart: ctx.span is undefined!')
      return
    }

    ctx.span.finish()
    log.debug('[WS-SERVER] asyncStart: span finished, spanId: %s', spanId)
  }
}

function getRequestProtocol (req, fallback = 'ws') {
  // 1. Check if the underlying TLS socket has 'encrypted'
  if (req.socket && req.socket.encrypted) {
    return 'wss'
  }

  // 2. Check for a trusted header set by a proxy
  if (req.headers && req.headers['x-forwarded-proto']) {
    const proto = req.headers['x-forwarded-proto'].split(',')[0].trim()
    if (proto === 'https') return 'wss'
    if (proto === 'http') return 'ws'
  }

  // 3. Fallback to ws
  return fallback
}

module.exports = WSServerPlugin
