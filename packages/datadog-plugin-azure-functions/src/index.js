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
    const { functionName, httpRequest, invocationContext, methodName } = ctx
    const store = storage('legacy').getStore()
    const childOf = methodName !== 'serviceBusQueue'
      ? extract(this._tracer, Object.fromEntries(httpRequest.headers.entries()))
      : null

    const span = this.startSpan(this.operationName(), {
      childOf,
      service: this.serviceName(),
      type: 'serverless',
      meta: {
        'aas.function.name': functionName,
        'aas.function.trigger': mapTriggerTag(methodName)
      }
    }, false)

    if (functionName === 'sendMessage') {
      // console.log("This is the context", ctx)
    }
    if (methodName === 'serviceBusQueue') {
      // console.log('This is the context for the q trigger', ctx)
      const { messageId, deliveryCount, enqueuedTimeUtc } = invocationContext.triggerMetadata
      if (messageId) span.setTag('messaging.message_id', messageId)
      if (deliveryCount) span.setTag('messaging.delivery_count', deliveryCount)
      if (enqueuedTimeUtc) span.setTag('messaging.enqueued_time', enqueuedTimeUtc)
      span.setTag('messaging.system', 'azure_service_bus')
      span.setTag('span.kind', 'consumer')
    }
    ctx.span = span
    ctx.parentStore = store
    ctx.currentStore = { ...store, span }

    if (invocationContext.options.return?.type === 'serviceBus') {
      const childSpan = this.startSpan('serviceBusOutput', {
        service: this.serviceName(),
        type: 'serverless',
        childOf: ctx.currentStore.span
      }, false)
      ctx.childSpan = childSpan
      ctx.currentStore = { ...ctx.currentStore, childSpan }
    }
    ctx.invocationContext.extraOutputs.hello = 'world'
    return ctx.currentStore
  }

  error (ctx) {
    this.addError(ctx.error)
    ctx.currentStore.span.setTag('error.message', ctx.error)
  }

  asyncEnd (ctx) {
    const { httpRequest, methodName, result = {} } = ctx

    // For Service Bus triggers, we don't have HTTP context
    if (methodName === 'serviceBusQueue') {
      ctx.currentStorespan.setTag('resource.name', 'serviceBusQueueTrigger')
      ctx.currentStore.span.finish()
    } else if (httpRequest) {
    // if (httpRequest) {
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

      if (ctx.currentStore.childSpan) {
        ctx.currentStore.childSpan.finish()
      }

      serverless.finishSpan(context)
    // Fallback for other trigger types
    } else {
      ctx.currentStore.span.finish()
    }
  }

  configure (config) {
    return super.configure(web.normalizeConfig(config))
  }
}

function mapTriggerTag (methodName) {
  return triggerMap[methodName] || 'Unknown'
}

function extract (tracer, headers) {
  if (!headers) return null
  return tracer.extract('http_headers', headers)
}
module.exports = AzureFunctionsPlugin
