'use strict'

// Plugin temporarily disabled. See https://github.com/DataDog/dd-trace-js/issues/312

const ServerPlugin = require('../../dd-trace/src/plugins/server')
const web = require('../../dd-trace/src/plugins/util/web')
const { COMPONENT } = require('../../dd-trace/src/constants')

class Http2ServerPlugin extends ServerPlugin {
  constructor (tracer, config) {
    super(tracer, config)
    this.addBind('apm:http2:server:response:emit', this.bindEmit)
  }

  static id = 'http2'

  static prefix = 'apm:http2:server:request'

  bindStart (ctx) {
    const { req, res } = ctx

    const span = web.startSpan(
      this.tracer,
      {
        ...this.config,
        service: this.config.service || this.serviceName()
      },
      req,
      res,
      this.operationName(),
      ctx
    )

    span.setTag(COMPONENT, this.constructor.id)
    span._integrationName = this.constructor.id

    ctx.currentStore.req = req
    ctx.currentStore.res = res

    const context = web.getContext(req)

    if (!context.instrumented) {
      context.res.writeHead = web.wrapWriteHead(context)
      context.instrumented = true
    }

    return ctx.currentStore
  }

  bindEmit (ctx) {
    if (ctx.eventName !== 'close') return ctx.currentStore

    const { req } = ctx

    const context = web.getContext(req)

    if (!context || !context.res) return // Not created by a http.Server instance.

    web.finishAll(context)

    return ctx.currentStore
  }

  error (error) {
    web.addError(error)
  }

  configure (config) {
    return super.configure(web.normalizeConfig(config))
  }
}

module.exports = Http2ServerPlugin
