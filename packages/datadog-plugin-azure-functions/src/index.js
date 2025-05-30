'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const serverless = require('../../dd-trace/src/plugins/util/serverless')
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

  static get prefix () { return 'tracing:datadog:azure:functions:invoke' }

  start (ctx) {
    const { functionName, methodName } = ctx

    const span = this.startSpan(this.operationName(), {
      service: this.serviceName(),
      type: 'serverless',
      meta: {
        'aas.function.name': functionName,
        'aas.function.trigger': mapTriggerTag(methodName)
      }
    }, ctx)

    ctx.span = span
  }

  error (ctx) {
    this.addError(ctx.error)
    ctx.currentStore.span.setTag('error.message', ctx.error)
  }

  asyncEnd (ctx) {
    const { httpRequest, result = {} } = ctx
    const path = (new URL(httpRequest.url)).pathname
    const req = {
      method: httpRequest.method,
      headers: Object.fromEntries(httpRequest.headers.entries()),
      url: path
    }

    const context = web.patch(req)
    context.config = this.config
    context.paths = [path]
    context.res = { statusCode: result.status }
    context.span = ctx.currentStore.span

    serverless.finishSpan(context)
  }

  configure (config) {
    return super.configure(web.normalizeConfig(config))
  }
}

function mapTriggerTag (methodName) {
  return triggerMap[methodName] || 'Unknown'
}

module.exports = AzureFunctionsPlugin
