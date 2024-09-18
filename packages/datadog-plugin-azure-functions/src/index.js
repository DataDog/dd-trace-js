'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const { storage } = require('../../datadog-core')
const web = require('../../dd-trace/src/plugins/util/web')

const triggerMap = {
  deleteRequest: 'Http',
  http: 'Http',
  get: 'Http',
  patch: 'Http',
  post: 'Http',
  put: 'Http'
}

class AzureFunctionsPlugin extends TracingPlugin {
  static get id () { return 'azure-functions' }
  static get operation () { return 'invoke' }
  static get kind () { return 'server' }
  static get type () { return 'serverless' }

  static get prefix () { return 'tracing:datadog:azure-functions:invoke' }

  bindStart (ctx) {
    const { functionName, methodName } = ctx
    const store = storage.getStore()

    const span = this.startSpan(this.operationName(), {
      service: this.serviceName(),
      type: 'serverless',
      meta: {
        'aas.function.name': functionName,
        'aas.function.trigger': mapTriggerTag(methodName)
      }
    }, false)

    ctx.span = span
    ctx.parentStore = store
    ctx.currentStore = { ...store, span }

    return ctx.currentStore
  }

  error (ctx) {
    this.addError(ctx.error)
    ctx.currentStore.span.setTag('error.message', ctx.error)
  }

  asyncEnd (ctx) {
    const { httpRequest, result = {} } = ctx
    const path = extractPath(httpRequest.url)
    const req = {
      method: httpRequest.method,
      headers: Object.fromEntries(httpRequest.headers.entries()),
      url: path
    }

    const context = web.patch(req)
    context.span = ctx.currentStore.span
    context.config = this.config
    context.paths = [path]

    // Use status for status code if available. Otherwise if no status is provided assume an internal server error
    context.res = { statusCode: result.hasOwnProperty('status') ? result.status : 500 }

    web.finishSpan(context)
  }

  configure (config) {
    return super.configure(web.normalizeConfig(config))
  }
}

function extractPath (url) {
  const regex = /https?:\/\/[^/]+(\/.*$)/
  const match = url.match(regex)
  return match ? match[1] : ''
}

function mapTriggerTag (methodName) {
  return triggerMap[methodName] || 'Unknown'
}

module.exports = AzureFunctionsPlugin
