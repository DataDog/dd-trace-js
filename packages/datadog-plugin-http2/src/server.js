'use strict'

// Plugin temporarily disabled. See https://github.com/DataDog/dd-trace-js/issues/312

const ServerPlugin = require('../../dd-trace/src/plugins/server')
const { storage } = require('../../datadog-core')
const web = require('../../dd-trace/src/plugins/util/web')
const { COMPONENT } = require('../../dd-trace/src/constants')

class Http2ServerPlugin extends ServerPlugin {
  static get id () {
    return 'http2'
  }

  static get prefix () {
    return 'apm:http2:server:request'
  }

  bindStart (ctx) {
    const { req, res } = ctx

    const store = storage('legacy').getStore()
    const span = web.startSpan(
      this.tracer,
      {
        ...this.config,
        service: this.config.service || this.serviceName()
      },
      req,
      res,
      this.operationName()
    )

    span.setTag(COMPONENT, this.constructor.id)
    span._integrationName = this.constructor.id

    this.enter(span, { ...store, req, res })

    const context = web.getContext(req)

    if (!context.instrumented) {
      context.res.writeHead = web.wrapWriteHead(context)
      context.instrumented = true
    }

    return ctx.currentStore
  }

  bindFinish (ctx) {
    const { req } = ctx

    const context = web.getContext(req)

    if (!context || !context.res) return // Not created by a http.Server instance.

    web.finishAll(context)

    return ctx.parentStore
  }

  error (error) {
    web.addError(error)
  }

  configure (config) {
    return super.configure(web.normalizeConfig(config))
  }
}

module.exports = Http2ServerPlugin
