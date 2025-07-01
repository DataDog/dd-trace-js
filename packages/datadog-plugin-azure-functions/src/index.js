'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const { storage } = require('../../datadog-core')
const serverless = require('../../dd-trace/src/plugins/util/serverless')
const web = require('../../dd-trace/src/plugins/util/web')

const triggerMap = {
  deleteRequest: 'Http',
  http: 'Http',
  get: 'Http',
  patch: 'Http',
  post: 'Http',
  put: 'Http',
  serviceBusQueue: 'serviceBusQueue'
}

class AzureFunctionsPlugin extends TracingPlugin {
  static get id () { return 'azure-functions' }
  static get operation () { return 'invoke' }
  static get kind () { return 'server' }
  static get type () { return 'serverless' }
  static get prefix () { return 'tracing:datadog:azure:functions:invoke' }

  bindStart (ctx) {
    const { functionName, methodName, invocationContext } = ctx
    const store = storage('legacy').getStore()
    const childOf = extractTraceContext(this._tracer, ctx)
    const span = this.startSpan(this.operationName(), {
      childOf,
      service: this.serviceName(),
      type: 'serverless',
      meta: {
        'aas.function.name': functionName,
        'aas.function.trigger': mapTriggerTag(methodName)
      }
    }, false)
    if (methodName === 'serviceBusQueue') {
      const triggerEntity = invocationContext.options.trigger.queueName || invocationContext.options.trigger.topicName
      span.setTag('messaging.message_id', invocationContext.triggerMetadata.messageId)
      span.setTag('messaging.operation', 'receive')
      span.setTag('messaging.system', 'servicebus')
      span.setTag('messaging.destination.name', triggerEntity)
      span.setTag('resource.name', 'serviceBusQueueTrigger')
      span.setTag('span.kind', 'consumer')
    }

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
    const { httpRequest, methodName, result = {} } = ctx
    if (triggerMap[methodName] === 'Http') {
      // If the method is an HTTP trigger, we need to patch the request and finish the span
      const path = (new URL(httpRequest.url)).pathname
      const req = {
        method: httpRequest.method,
        headers: Object.fromEntries(httpRequest.headers),
        url: path
      }
      const context = web.patch(req)
      context.config = this.config
      context.paths = [path]
      context.res = { statusCode: result.status }
      context.span = ctx.currentStore.span

      serverless.finishSpan(context)
    // Fallback for other trigger types
    } else {
      super.finish()
    }
  }

  configure (config) {
    return super.configure(web.normalizeConfig(config))
  }
}

function mapTriggerTag (methodName) {
  return triggerMap[methodName] || 'Unknown'
}

function extractTraceContext (tracer, ctx) {
  switch (String(ctx.methodName)) {
    case triggerMap.http:
      return tracer.extract('http_headers', Object.fromEntries(ctx.httpRequest.headers))
    case triggerMap.serviceBusQueue:
      return tracer.extract('text_map', ctx.invocationContext.triggerMetadata.applicationProperties)
  }
}

module.exports = AzureFunctionsPlugin
