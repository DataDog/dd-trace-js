'use strict'

const ServerPlugin = require('../../dd-trace/src/plugins/server')
const { storage } = require('../../datadog-core')
const { withRequest } = require('../../dd-trace/src/appsec/store')
const web = require('../../dd-trace/src/plugins/util/web')
const { incomingHttpRequestStart, incomingHttpRequestEnd } = require('../../dd-trace/src/appsec/channels')
const { COMPONENT, SVC_SRC_KEY } = require('../../dd-trace/src/constants')

const legacyStorage = storage('legacy')

class HttpServerPlugin extends ServerPlugin {
  static id = 'http'

  static prefix = 'apm:http:server:request'

  /** @type {string | undefined} */
  #operationName

  /** @type {object | undefined} */
  #startConfig

  /** @type {string | undefined} */
  #serviceSource

  constructor (...args) {
    super(...args)
    this.addTraceSub('exit', message => this.exit(message))
  }

  start (ctx) {
    const { req, res } = ctx
    let store = legacyStorage.getStore()
    if (this.#startConfig === undefined) {
      this.#refreshStartCache()
    }
    // A fresh request has no span yet; web.startSpan creates and enters one.
    // A reused context (HTTP/2 stream, serverless re-entry) returns the
    // existing span without entering, so the explicit enter below is the only
    // one in that case.
    const spanCreated = !web.getContext(req)?.span
    const span = web.startSpan(
      this.tracer,
      this.#startConfig,
      req,
      res,
      this.#operationName
    )
    if (this.#serviceSource !== undefined) {
      span.setTag(SVC_SRC_KEY, this.#serviceSource)
    }
    span.setTag(COMPONENT, this.constructor.id)
    span._integrationName = this.constructor.id

    const context = web.getContext(req)
    context.parentStore = store

    const appsecActive = incomingHttpRequestStart.hasSubscribers
    if (appsecActive) {
      // AppSec, IAST, and AI Guard need req on the store so downstream
      // subscribers can access them from the async context.
      store = withRequest(store, req)
    }

    // Skip the re-enter when web.startSpan already entered { ...store, span }
    // and AppSec did not rebuild the store with req: the bind would be
    // identical to the one startSpan just made.
    if (!spanCreated || appsecActive) {
      this.enter(span, store)
    }

    if (!context.instrumented) {
      context.res.writeHead = web.wrapWriteHead(context)
      context.instrumented = true
    }

    if (appsecActive) {
      // Reuse the ctx allocated by the HTTP server instrumentation rather
      // than a fresh `{ req, res, abortController }` per request; the AppSec
      // subscriber only reads from the message.
      incomingHttpRequestStart.publish(ctx)
    }
  }

  error (error) {
    web.addError(error)
  }

  finish ({ req }) {
    const context = web.getContext(req)

    if (!context || !context.res) return // Not created by a http.Server instance.

    if (incomingHttpRequestEnd.hasSubscribers) {
      incomingHttpRequestEnd.publish({ req, res: context.res })
    }

    web.finishAll(context)
  }

  exit ({ req }) {
    const context = web.getContext(req)
    const parentStore = context?.parentStore

    const span = parentStore?.span
    this.enter(span, parentStore)

    if (context) {
      context.parentStore = undefined
    }
  }

  configure (config) {
    const result = super.configure(web.normalizeConfig(config))
    // Invalidate the start-cache; the next `start` refills it. Resolving
    // service / operation eagerly here would pin nomenclature lookups to
    // the order plugins and tracer initialise.
    this.#startConfig = undefined
    return result
  }

  #refreshStartCache () {
    const { name: schemaServiceName, source: schemaServiceSource } = this.serviceName()
    const tracerService = this.tracer._service
    const configService = this.config.service
    const service = configService || schemaServiceName
    this.#serviceSource = (configService && service !== tracerService)
      ? 'opt.plugin'
      : (service === tracerService ? undefined : schemaServiceSource)
    this.#operationName = this.operationName()
    this.#startConfig = { ...this.config, service }
  }
}

module.exports = HttpServerPlugin
