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
    this._parentStore = undefined
    this.addTraceSub('exit', message => this.exit(message))
  }

  start ({ req, res, abortController }) {
    const store = storage('legacy').getStore()
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
    span.setTag(COMPONENT, HttpServerPlugin.id)
    span._integrationName = HttpServerPlugin.id

    this._parentStore = store
    this.enter(span, getRequestStore(store, req, res))

    const context = web.getContext(req)
    if (context && !context.instrumented) {
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
    // When AppSec is enabled, keep the request scope active for any async work that
    // may be scheduled after the synchronous `request` event returns (e.g. Fastify).
    // AppSec/RASP relies on `storage('legacy').getStore()?.req` being available
    // when instrumenting downstream operations (like outbound HTTP requests).
    if (incomingHttpRequestStart.hasSubscribers || incomingHttpRequestEnd.hasSubscribers) {
      this._parentStore = undefined
      return
    }

    const parentSpan = this._parentStore && this._parentStore.span
    const context = web.getContext(req)
    const res = context && context.res

    this.enter(parentSpan, getRequestStore(this._parentStore, req, res))
    this._parentStore = undefined
  }

  configure (config) {
    return super.configure(web.normalizeConfig(config))
  }
}

function getRequestStore (store, req, res) {
  if (!req || !res) return store

  // Only attach request-scoped data to the store when AppSec needs it.
  if (!incomingHttpRequestStart.hasSubscribers && !incomingHttpRequestEnd.hasSubscribers) {
    return store
  }

  store = store ? { ...store } : {}
  store.req = req
  store.res = res
  return store
}

module.exports = HttpServerPlugin
