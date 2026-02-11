'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing.js')
const tags = require('../../../ext/tags.js')
const { HTTP_HEADERS } = require('../../../ext/formats')
const {
  createWebSocketSpanContext,
  hasTraceHeaders,
  initWebSocketMessageCounters,
} = require('./util')

const HTTP_STATUS_CODE = tags.HTTP_STATUS_CODE

class WSServerPlugin extends TracingPlugin {
  static get id () { return 'ws' }
  static get prefix () { return 'tracing:ws:server:connect' }
  static get type () { return 'websocket' }
  static get kind () { return 'request' }

  constructor (...args) {
    super(...args)

    // Bind the setSocket channel so internal ws event handlers (data, close)
    // don't capture their async context.
    this.addBind('tracing:ws:server:connect:setSocket', () => {})
  }

  bindStart (ctx) {
    const req = ctx.req

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
    const resourceName = `${options.method} ${route}`

    ctx.args = { options }

    // Extract distributed tracing context from request headers
    const childOf = this.tracer.extract(HTTP_HEADERS, req.headers)

    const service = this.serviceName({ pluginConfig: this.config })
    const span = this.startSpan(this.operationName(), {
      service,
      childOf,
      meta: {
        'span.type': 'websocket',
        'http.upgraded': 'websocket',
        'http.method': options.method,
        'http.url': uri,
        'resource.name': resourceName,
        'span.kind': 'server',
      },

    }, ctx)
    ctx.span = span

    ctx.socket.spanTags = {
      'resource.name': resourceName,
      'service.name': service,
    }
    ctx.socket.spanContext = createWebSocketSpanContext(ctx.span._spanContext)
    ctx.socket.hasTraceHeaders = hasTraceHeaders(req.headers)

    // Initialize message counters for span pointers
    initWebSocketMessageCounters(ctx.socket)

    return ctx.currentStore
  }

  bindAsyncStart (ctx) {
    ctx.span.setTag(HTTP_STATUS_CODE, ctx.req.resStatus)

    return ctx.parentStore
  }

  asyncStart (ctx) {
    ctx.span.finish()
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
