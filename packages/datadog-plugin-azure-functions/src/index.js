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
  put: 'Http',
  serviceBusQueue: 'ServiceBus',
  serviceBusTopic: 'ServiceBus',
  eventHub: 'EventHubs',
}

class AzureFunctionsPlugin extends TracingPlugin {
  static id = 'azure-functions'
  static operation = 'invoke'
  static kind = 'server'
  static type = 'serverless'
  static prefix = 'tracing:datadog:azure:functions:invoke'

  bindStart (ctx) {
    const childOf = extractTraceContext(this._tracer, ctx)
    const meta = getMetaForTrigger(ctx)
    const triggerType = triggerMap[ctx.methodName]
    const isMessagingService = (triggerType === 'ServiceBus' || triggerType === 'EventHubs')
    const span = this.startSpan(this.operationName(), {
      childOf,
      service: this.serviceName(),
      type: 'serverless',
      meta,
    }, ctx)

    if (isMessagingService) {
      setSpanLinks(this.tracer, span, ctx)
    }

    ctx.span = span
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

function getMetaForTrigger ({ functionName, methodName, invocationContext }) {
  let meta = {
    'aas.function.name': functionName,
    'aas.function.trigger': mapTriggerTag(methodName)
  }

  if (triggerMap[methodName] === 'ServiceBus') {
    const triggerEntity = invocationContext.options.trigger.queueName || invocationContext.options.trigger.topicName
    meta = {
      ...meta,
      'messaging.message_id': invocationContext.triggerMetadata.messageId,
      'messaging.operation': 'receive',
      'messaging.system': 'servicebus',
      'messaging.destination.name': triggerEntity,
      'resource.name': `ServiceBus ${functionName}`,
      'span.kind': 'consumer'
    }
  } else if (triggerMap[methodName] === 'EventHubs') {
    const partitionContext = invocationContext.triggerMetadata.triggerPartitionContext
    meta = {
      ...meta,
      'messaging.destination.name': partitionContext.eventHubName,
      'messaging.operation': 'receive',
      'messaging.system': 'eventhub',
      'resource.name': `EventHubs ${functionName}`,
      'span.kind': 'consumer'
    }
  }

  return meta
}

function mapTriggerTag (methodName) {
  return triggerMap[methodName] || 'Unknown'
}

function extractTraceContext (tracer, ctx) {
  switch (String(triggerMap[ctx.methodName])) {
    case 'Http':
      return tracer.extract('http_headers', Object.fromEntries(ctx.httpRequest.headers))
    case 'ServiceBus':
      return tracer.extract('text_map', ctx.invocationContext.triggerMetadata.applicationProperties)
    default:
      null
  }
}

function setSpanLinks (tracer, span, ctx) {
  const cardinality = ctx.invocationContext.options.trigger.cardinality
  const triggerMetadata = ctx.invocationContext.triggerMetadata
  if (cardinality === 'many' && triggerMetadata.propertiesArray.length > 0) {
    triggerMetadata.propertiesArray.forEach(event => {
      span.addLink(tracer.extract('text_map', event))
    })
  } else if (cardinality === 'one') {
    const spanContext = tracer.extract('text_map', triggerMetadata.properties)
    if (spanContext) {
      span.addLink(spanContext)
    }
  }
}

module.exports = AzureFunctionsPlugin
