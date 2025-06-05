'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing.js')
const tags = require('../../../ext/tags')

const HTTP_STATUS_CODE = tags.HTTP_STATUS_CODE
const HTTP_REQUEST_HEADERS = tags.HTTP_REQUEST_HEADERS
const HTTP_RESPONSE_HEADERS = tags.HTTP_RESPONSE_HEADERS

class WSPlugin extends TracingPlugin {
  static get id () { return 'ws' }
  // static get id () { return 'http' }
  static get prefix () { return 'tracing:ws:client:connect' }
  static get type () { return 'websocket' }
  static get kind () { return 'consumer' }

  bindStart (ctx) {
    const { http = {} } = ctx
    const req = ctx.req

    const options = {}
    const headers = Object.entries(req.headers)
    options.headers = Object.fromEntries(headers)
    options.method = req.method

    const agent = options.agent || options._defaultAgent || http.globalAgent || {}
    const protocol = options.protocol || agent.protocol || 'http:'
    const hostname = options.hostname || options.host || 'localhost'
    const host = options.port ? `${hostname}:${options.port}` : hostname
    const pathname = options.path || options.pathname
    const path = pathname ? pathname.split(/[?#]/)[0] : '/'
    const uri = `${protocol}//${host}${path}`

    ctx.args = { options }

    const span = this.startSpan(this.operationName(), {
      meta: {
        service: this.serviceName({ pluginConfig: this.config }),
        'span.type': 'ws',
        'http.upgraded': 'websocket',
        'http.method': options.method,
        'http.url': uri,
        'resource.name': options.method,
        'span.kind': 'server'

      }

    }, true)
    ctx.span = span
    ctx.currentStore = { span }

    return ctx.currentStore
  }

  // asyncStart (ctx) {

  //   ctx?.currentStore?.span.finish()

  //   ctx.res = ctx.resStatus

  //   ctx.currentStore.span.setTag(HTTP_STATUS_CODE, ctx.res)

  //   return ctx.currentStore
  // }

  end (ctx) {
    ctx.req.res = ctx.resStatus

    ctx.span.setTag(HTTP_STATUS_CODE, ctx.req.res)
    if (!ctx.span) return
    ctx.span.finish()
  }

  // asyncEnd (ctx) {
  //   ctx.res = ctx.resStatus

  //   ctx.currentStore.span.setTag(HTTP_STATUS_CODE, ctx.res)
  //   ctx.span.setTag(HTTP_STATUS_CODE, ctx.res)

  //   return this.finish(ctx)
  // }
}

module.exports = WSPlugin
