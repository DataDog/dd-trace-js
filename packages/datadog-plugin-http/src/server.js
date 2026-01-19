'use strict'

const ServerPlugin = require('../../dd-trace/src/plugins/server')
const { storage } = require('../../datadog-core')
const web = require('../../dd-trace/src/plugins/util/web')
const { incomingHttpRequestStart, incomingHttpRequestEnd } = require('../../dd-trace/src/appsec/channels')
const { COMPONENT } = require('../../dd-trace/src/constants')

class HttpServerPlugin extends ServerPlugin {
  static id = 'http'

  static prefix = 'apm:http:server:request'

  constructor (...args) {
    super(...args)
    this.addTraceSub('exit', message => this.exit(message))
  }

  start ({ req, res, abortController }) {
    let store = storage('legacy').getStore()
    const span = web.startSpan(
      this.tracer,
      {
        ...this.config,
        service: this.config.service || this.serviceName(),
      },
      req,
      res,
      this.operationName()
    )
    span.setTag(COMPONENT, this.constructor.id)
    span._integrationName = this.constructor.id

    const context = web.getContext(req)

    if (context) {
      context.parentStore = store
    }

    if (incomingHttpRequestStart.hasSubscribers) {
      const weakReq = new WeakRef(req)
      const weakRes = new WeakRef(res)
      store = Object.create(store ?? null)
      Object.defineProperty(store, 'req', {
        configurable: true,
        enumerable: false,
        get () { return weakReq.deref() }
      })

      Object.defineProperty(store, 'res', {
        configurable: true,
        enumerable: false,
        get () { return weakRes.deref() }
      })
    }

    this.enter(span, store)

    if (!context.instrumented) {
      context.res.writeHead = web.wrapWriteHead(context)
      context.instrumented = true
    }

    if (incomingHttpRequestStart.hasSubscribers) {
      incomingHttpRequestStart.publish({ req, res, abortController }) // TODO: no need to make a new object here
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
    return super.configure(web.normalizeConfig(config))
  }
}

module.exports = HttpServerPlugin
