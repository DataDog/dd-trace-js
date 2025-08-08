'use strict'

// Plugin temporarily disabled. See https://github.com/DataDog/dd-trace-js/issues/312

const WebPlugin = require('../../datadog-plugin-web/src')
const { COMPONENT } = require('../../dd-trace/src/constants')

class Http2ServerPlugin extends WebPlugin {
  constructor (tracer, config) {
    super(tracer, config)
    this.addBind('apm:http2:server:response:emit', this.bindEmit)
  }

  static id = 'http2'

  static prefix = 'apm:http2:server:request'

  bindStart (ctx) {
    const { req, res } = ctx

    const span = this.startSpan(
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

    const context = this.getContext(req)

    if (!context.instrumented) {
      context.res.writeHead = this.wrapWriteHead(context)
      context.instrumented = true
    }

    return ctx.currentStore
  }

  bindEmit (ctx) {
    if (ctx.eventName !== 'close') return ctx.currentStore

    const { req } = ctx

    const context = this.getContext(req)

    if (!context || !context.res) return // Not created by a http.Server instance.

    this.finishAll(context)

    return ctx.currentStore
  }

  error (error) {
    this.addError(error)
  }

  configure (config) {
    return super.configure(this.normalizeConfig(config))
  }
}

module.exports = Http2ServerPlugin
