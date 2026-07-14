'use strict'

const ServerPlugin = require('../../dd-trace/src/plugins/server')
const web = require('../../dd-trace/src/plugins/util/web')
const { COMPONENT, SVC_SRC_KEY } = require('../../dd-trace/src/constants')

class Http2ServerPlugin extends ServerPlugin {
  constructor (tracer, config) {
    super(tracer, config)
    this.addBind('apm:http2:server:response:emit', this.bindEmit)
    this.addSub('apm:http2:server:request:adopt', this.adopt)
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

    // A mixed server adopts the real request off this stream later; key the
    // context on the stream now so that lookup resolves. Skipped for the common
    // single-listener request, which never adopts.
    if (ctx.adoptable) web.linkContextToStream(req.stream, context)

    instrumentWriteHead(context)

    return ctx.currentStore
  }

  // A mixed server (raw-stream + 'request' listeners) creates the span from the
  // 'stream' event with a throwaway adapter. When the compatibility layer then
  // synthesizes the real request/response off the same stream, point the shared
  // context at them so `web.setFramework`/`web.setRoute` from the user's
  // 'request' handler resolve to this span and the finish `hooks.request`
  // receives the real objects instead of the adapter.
  adopt (ctx) {
    const context = web.patch(ctx.req)
    context.req = ctx.req
    context.res = ctx.res
    instrumentWriteHead(context)
  }

  bindEmit (ctx) {
    // Both the compatibility response and the core-API stream emit 'close'
    // exactly once, so the span is finished from a single source. `web.js`
    // bypasses its `finished` idempotency guard for stream-backed requests
    // (`!req.stream`); that bypass is harmless here only because of this
    // single-finish property.
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

// The core stream API has no `res.writeHead`; CORS preflight tagging only
// applies to the compatibility response that exposes it. Runs once per context:
// the mixed path calls it again from `adopt` once the real response is in place.
/**
 * @param {{ res: { writeHead?: Function }, instrumented?: boolean }} context
 */
function instrumentWriteHead (context) {
  if (!context.instrumented && typeof context.res.writeHead === 'function') {
    context.res.writeHead = web.wrapWriteHead(context)
    context.instrumented = true
  }
}

module.exports = Http2ServerPlugin
