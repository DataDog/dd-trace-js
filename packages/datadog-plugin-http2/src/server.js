'use strict'

const ServerPlugin = require('../../dd-trace/src/plugins/server')
const { storage } = require('../../datadog-core')
const web = require('../../dd-trace/src/plugins/util/web')
const { withRequest } = require('../../dd-trace/src/appsec/store')
const { incomingHttpRequestStart, incomingHttpRequestEnd } = require('../../dd-trace/src/appsec/channels')
const { COMPONENT, SVC_SRC_KEY } = require('../../dd-trace/src/constants')

const legacyStorage = storage('legacy')

class Http2ServerPlugin extends ServerPlugin {
  constructor (tracer, config) {
    super(tracer, config)
    this.addBind('apm:http2:server:response:emit', this.bindEmit)
  }

  static id = 'http2'

  static prefix = 'apm:http2:server:request'

  bindStart (ctx) {
    const { req, res } = ctx

    const { name: schemaServiceName, source: schemaServiceSource } = this.serviceName()
    const service = this.config.service || schemaServiceName
    const serviceSource = (this.config.service && service !== this.tracer._service)
      ? 'opt.plugin'
      : (service === this.tracer._service ? undefined : schemaServiceSource)
    const span = web.startSpan(
      this.tracer,
      {
        ...this.config,
        service,
      },
      req,
      res,
      this.operationName(),
      ctx
    )
    if (serviceSource !== undefined) {
      span.setTag(SVC_SRC_KEY, serviceSource)
    }

    span.setTag(COMPONENT, this.constructor.id)
    span._integrationName = this.constructor.id

    ctx.currentStore.req = req
    ctx.currentStore.res = res

    const context = web.getContext(req)

    // The core stream API has no `res.writeHead`; CORS preflight tagging only
    // applies to the compatibility response that exposes it.
    if (!context.instrumented && typeof context.res.writeHead === 'function') {
      context.res.writeHead = web.wrapWriteHead(context)
      context.instrumented = true
    }

    if (incomingHttpRequestStart.hasSubscribers) {
      // AppSec and IAST observe both HTTP/2 APIs through the same bridge the
      // plain `http` plugin publishes; they read `req` off the async store.
      // The bind enters `currentStore` only after this returns, so enter it
      // here first — subscribers resolve their context from the active store.
      ctx.currentStore = withRequest(ctx.currentStore, req)
      legacyStorage.enterWith(ctx.currentStore)
      incomingHttpRequestStart.publish(ctx)
    }

    return ctx.currentStore
  }

  bindEmit (ctx) {
    if (ctx.eventName !== 'close') return ctx.currentStore

    const { req } = ctx

    const context = web.getContext(req)

    if (!context || !context.res) return // Not created by a http.Server instance.

    if (incomingHttpRequestEnd.hasSubscribers) {
      incomingHttpRequestEnd.publish({ req, res: context.res })
    }

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
