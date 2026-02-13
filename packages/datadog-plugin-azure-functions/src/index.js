'use strict'

const { http } = require('../../dd-trace/src/plugins')
const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
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
    const meta = getMetaForTrigger(ctx)
    const triggerType = triggerMap[ctx.methodName]
    const isHttpTrigger = triggerType === 'Http'
    const isMessagingService = (triggerType === 'ServiceBus' || triggerType === 'EventHubs')

    let span

    if (isHttpTrigger) {
      const { httpRequest } = ctx
      const path = (new URL(httpRequest.url)).pathname
      const req = {
        method: httpRequest.method,
        headers: httpRequest.headers,
        url: path,
      }
      // Patch the request to create web context
      const webContext = web.patch(req)
      webContext.config = this.config
      webContext.tracer = this.tracer
      // Creates a standard span and an inferred proxy span if headers are present
      span = web.startServerlessSpanWithInferredProxy(
        this.tracer,
        this.config,
        this.operationName(),
        req,
        ctx
      )

      span.addTags(meta)
      webContext.span = span
      webContext.azureFunctionCtx = ctx
      ctx.webContext = webContext
    } else {
      // For non-HTTP triggers, use standard flow
      span = this.startSpan(this.operationName(), {
        service: this.serviceName(),
        type: 'serverless',
        meta,
      }, ctx)

      if (isMessagingService) {
        setSpanLinks(triggerType, this.tracer, span, ctx)
      }
    }
    ctx.span = span
    return ctx.currentStore
  }

  error (ctx) {
    this.addError(ctx.error)
    ctx.currentStore.span.setTag('error.message', ctx.error)
  }

  asyncStart (ctx) {
    const { methodName, result = {}, webContext } = ctx
    const triggerType = triggerMap[methodName]

    // For HTTP triggers, use web utilities to finish all spans (including inferred proxy)
    if (triggerType === 'Http') {
      if (webContext) {
        webContext.res = { statusCode: result.status }
        web.finishAll(webContext, 'serverless')
      }
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
    'aas.function.trigger': mapTriggerTag(methodName),
    'span.type': 'serverless',
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
      'span.kind': 'consumer',
    }
  } else if (triggerMap[methodName] === 'EventHubs') {
    const partitionContext = invocationContext.triggerMetadata.triggerPartitionContext
    meta = {
      ...meta,
      'messaging.destination.name': partitionContext.eventHubName,
      'messaging.operation': 'receive',
      'messaging.system': 'eventhubs',
      'resource.name': `EventHubs ${functionName}`,
      'span.kind': 'consumer',
    }
  }

  return meta
}

function mapTriggerTag (methodName) {
  return triggerMap[methodName] || 'Unknown'
}

// message & messages & batch with cardinality of 1 == applicationProperties
// messages with cardinality of many == applicationPropertiesArray
function setSpanLinks (triggerType, tracer, span, ctx) {
  const cardinality = ctx.invocationContext.options.trigger.cardinality
  const triggerMetadata = ctx.invocationContext.triggerMetadata
  const isServiceBus = triggerType === 'ServiceBus'

  const properties = isServiceBus
    ? triggerMetadata.applicationProperties
    : triggerMetadata.properties

  const propertiesArray = isServiceBus
    ? triggerMetadata.applicationPropertiesArray
    : triggerMetadata.propertiesArray

  const addLinkFromProperties = (props) => {
    if (!props || Object.keys(props).length === 0) return
    const spanContext = tracer.extract('text_map', props)
    if (spanContext) {
      span.addLink(spanContext)
    }
  }

  if (cardinality === 'many' && propertiesArray?.length > 0) {
    for (const prop of propertiesArray) {
      addLinkFromProperties(prop)
    }
  } else if (cardinality === 'one') {
    addLinkFromProperties(properties)
  }
}

module.exports = AzureFunctionsPlugin
