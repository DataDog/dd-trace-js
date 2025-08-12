'use strict'

const WebPlugin = require('../../datadog-plugin-web/src')
const { storage } = require('../../datadog-core')
const { incomingHttpRequestStart, incomingHttpRequestEnd } = require('../../dd-trace/src/appsec/channels')
const { COMPONENT } = require('../../dd-trace/src/constants')

class HttpServerPlugin extends WebPlugin {
  static id = 'http'
  static prefix = 'apm:http:server:request'
  static type = 'web'
  static kind = 'server'

  constructor (...args) {
    super(...args)
    this._parentStore = undefined
    this.addTraceSub('exit', message => this.exit(message))
  }

  start ({ req, res, abortController }) {
    const store = storage('legacy').getStore()

    this.config.service = this.config.service || this.getServiceName()

    const span = this.startSpan(
      req,
      res,
      this.operationName()
    )
    span.setTag(COMPONENT, this.constructor.id)
    span._integrationName = this.constructor.id

    this._parentStore = store
    this.enter(span, { ...store, req, res })

    const context = this.getContext(req)

    if (!context.instrumented) {
      context.res.writeHead = this.wrapWriteHead(context)
      context.instrumented = true
    }

    if (incomingHttpRequestStart.hasSubscribers) {
      incomingHttpRequestStart.publish({ req, res, abortController }) // TODO: no need to make a new object here
    }
  }

  error (error) {
    this.addError(error)
  }

  finish ({ req }) {
    const context = this.getContext(req)

    if (!context || !context.res) return // Not created by a http.Server instance.

    if (incomingHttpRequestEnd.hasSubscribers) {
      incomingHttpRequestEnd.publish({ req, res: context.res })
    }

    this.finishAll(context)
  }

  exit ({ req }) {
    const span = this._parentStore && this._parentStore.span
    this.enter(span, this._parentStore)
    this._parentStore = undefined
  }

  configure (config) {
    return super.configure(this.normalizeConfig(config))
  }
}

module.exports = HttpServerPlugin
