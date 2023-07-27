'use strict'

const ServerPlugin = require('../../dd-trace/src/plugins/server')
const { storage } = require('../../datadog-core')
const web = require('../../dd-trace/src/plugins/util/web')
const { incomingHttpRequestStart, incomingHttpRequestEnd } = require('../../dd-trace/src/appsec/channels')
const { COMPONENT } = require('../../dd-trace/src/constants')

class HttpServerPlugin extends ServerPlugin {
  static get id () {
    return 'http'
  }

  constructor (...args) {
    super(...args)
    this._parentStore = undefined
    this.addTraceSub('exit', message => this.exit(message))
  }

  addTraceSub (eventName, handler) {
    this.addSub(`apm:${this.constructor.id}:server:${this.operation}:${eventName}`, handler)
  }

  start ({ req, res, abortController }) {
    const store = storage.getStore()
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

    this._parentStore = store
    this.enter(span, { ...store, req, res })

    const context = web.getContext(req)

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
    const span = this._parentStore && this._parentStore.span
    this.enter(span, this._parentStore)
    this._parentStore = undefined
  }

  configure (config) {
    return super.configure(web.normalizeConfig(config))
  }
}

module.exports = HttpServerPlugin
