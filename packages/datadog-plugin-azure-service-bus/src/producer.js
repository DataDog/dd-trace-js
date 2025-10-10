'use strict'

const { getEnvironmentVariable } = require('../../dd-trace/src/config-helper')
const ProducerPlugin = require('../../dd-trace/src/plugins/producer')

class AzureServiceBusProducerPlugin extends ProducerPlugin {
  static get id () { return 'azure-service-bus' }
  static get operation () { return 'send' }
  static get prefix () { return 'tracing:apm:azure-service-bus:send' }

  bindStart (ctx) {
    const { config, entityPath, functionName, msg } = ctx
    const qualifiedSenderNamespace = config.host
    const span = this.startSpan({
      resource: entityPath,
      type: 'messaging',
      meta: {
        component: 'azure-service-bus',
        'messaging.destination.name': entityPath,
        'messaging.operation': 'send',
        'messaging.system': 'servicebus',
        'network.destination.name': qualifiedSenderNamespace,
      }
    }, ctx)

    injectTraceContext(this.tracer, span, msg)

    if (functionName === 'tryAddMessage') {
      span._spanContext._name === 'azure.servicebus.create'
      span.setTag('messaging.operation', 'create')

      if (msg.messageID !== undefined) {
        span.setTag('message.id', msg)
      }

      if (batchLinksAreEnabled()) {
        ctx.batch._spanContexts.push(span.context())
        injectTraceContext(this.tracer, span, msg)
      }
    }

    return ctx.currentStore
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
