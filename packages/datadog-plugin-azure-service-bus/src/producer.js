'use strict'

const { getEnvironmentVariable } = require('../../dd-trace/src/config-helper')
const ProducerPlugin = require('../../dd-trace/src/plugins/producer')

class AzureServiceBusProducerPlugin extends ProducerPlugin {
  static get id () { return 'azure-service-bus' }
  static get operation () { return 'send' }
  static get prefix () { return 'tracing:apm:azure-service-bus:send' }

  bindStart (ctx) {
    // we do not want to make these spans when batch linking is disabled.
    if (!batchLinksAreEnabled() && ctx.functionName === 'tryAddMessage') {
      return ctx.currentStore
    }

    const qualifiedSenderNamespace = ctx.config.host
    const span = this.startSpan({
      resource: ctx.entityPath,
      type: 'messaging',
      meta: {
        component: 'azure-service-bus',
        'messaging.destination.name': ctx.entityPath,
        'messaging.operation': 'send',
        'messaging.system': 'servicebus',
        'network.destination.name': qualifiedSenderNamespace,
      }
    }, ctx)

    if (ctx.functionName === 'tryAddMessage') {
      span._spanContext._name === 'azure.servicebus.create'
      span.setTag('messaging.operation', 'create')

      if (ctx.msg.messageID !== undefined) {
        span.setTag('message.id', ctx.msg)
      }

      if (batchLinksAreEnabled()) {
        ctx.batch._spanContexts.push(span.context())
        injectTraceContext(this.tracer, span, ctx.msg)
      }
    }

    if (ctx.functionName === 'sendMessages') {
      span.setTag('messaging.operation', 'send')

      const messages = ctx.msg
      const isBatch = messages.constructor.name === 'ServiceBusMessageBatchImpl'

      if (isBatch) {
        const messagesLength = messages.length || messages._context?.connection?._eventsCount
        span.setTag('messaging.batch.message_count', messagesLength)

        if (batchLinksAreEnabled()) {
          messages._spanContexts.forEach(spanContext => {
            span.addLink(spanContext)
          })
        }
      } else if (Array.isArray(messages)) {
        const messagesLength = messages.length || messages._context?.connection?._eventsCount
        span.setTag('messaging.batch.message_count', messagesLength)

        messages.forEach(event => {
          injectTraceContext(this.tracer, span, event)
        })
      } else {
        injectTraceContext(this.tracer, span, messages)
      }
    }
    return ctx.currentStore
  }

  asyncEnd (ctx) {
    super.finish()
  }
}

function injectTraceContext (tracer, span, msg) {
  if (!msg.applicationProperties) {
    msg.applicationProperties = {}
  }

  tracer.inject(span, 'text_map', msg.applicationProperties)
}

function batchLinksAreEnabled () {
  const sb = getEnvironmentVariable('DD_TRACE_AZURE_SERVICEBUS_BATCH_LINKS_ENABLED')
  return sb !== 'false'
}

module.exports = AzureServiceBusProducerPlugin
