'use strict'

const ServerPlugin = require('../../dd-trace/src/plugins/server')
const { storage } = require('../../datadog-core')
const web = require('../../dd-trace/src/plugins/util/web')
const { adoptRequest, withRequest } = require('../../dd-trace/src/appsec/store')
const { incomingHttpRequestStart, incomingHttpRequestEnd } = require('../../dd-trace/src/appsec/channels')
const { COMPONENT, SVC_SRC_KEY } = require('../../dd-trace/src/constants')

const legacyStorage = storage('legacy')

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

    // Some compatibility requests adopt their real request from this stream.
    // Skip the map write for the common request-only path, which never adopts.
    if (ctx.adoptable) web.linkContextToStream(req.stream, context)

    if (!ctx.streamResponse) instrumentWriteHead(context)

    if (incomingHttpRequestStart.hasSubscribers) {
      // AppSec and IAST observe both HTTP/2 APIs through the same bridge the
      // plain `http` plugin publishes; they read `req` off the async store.
      // The bind enters `currentStore` only after this returns, so scope the
      // publication explicitly — subscribers resolve context from the store.
      ctx.currentStore = withRequest(ctx.currentStore, req)
      ctx.abortController = new AbortController()
      legacyStorage.run(ctx.currentStore, publishIncomingHttpRequestStart, ctx)
    }

    return ctx.currentStore
  }

  // A stream-backed request starts with an adapter. Point its shared context at
  // the compatibility objects before the user's event handler runs.
  adopt (ctx) {
    const context = web.patch(ctx.req)
    adoptRequest({ req: ctx.req, canonicalRequest: context.req })
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
    if (context.finished) return ctx.currentStore

    if (incomingHttpRequestEnd.hasSubscribers) {
      if (req !== context.req) copyRequestData(req, context.req)
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

/**
 * @param {{ req: object, res: object, abortController: AbortController }} ctx
 * @returns {void}
 */
function publishIncomingHttpRequestStart (ctx) {
  incomingHttpRequestStart.publish(ctx)
}

/**
 * @param {object} target
 * @param {object} source
 */
function copyRequestData (target, source) {
  if (source.body !== undefined) target.body = source.body
  if (source.cookies !== undefined) target.cookies = source.cookies
  if (source.query !== undefined) target.query = source.query
}

// The core stream API has no `res.writeHead`; CORS preflight tagging only
// applies to the compatibility response that exposes it. Runs once per context:
// a stream-backed path calls it again from `adopt` once the real response is in place.
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
