'use strict'

const { getEnvironmentVariable } = require('../../dd-trace/src/config-helper')
const ProducerPlugin = require('../../dd-trace/src/plugins/producer')

class AzureEventHubsProducerPlugin extends ProducerPlugin {
  static get id () { return 'azure-event-hubs' }
  static get operation () { return 'send' }
  static get prefix () { return 'tracing:apm:azure-event-hubs:send' }

  bindStart (ctx) {
    const qualifiedNamespace = ctx.config.endpoint.replace('sb://', '').replace('/', '')
    const entityPath = ctx.config.entityPath
    const span = this.startSpan({
      resource: entityPath,
      type: 'messaging',
      meta: {
        component: 'azure-event-hubs',
        'messaging.system': 'eventhubs',
        'messaging.destination.name': entityPath,
        'network.destination.name': qualifiedNamespace,
      }
    }, ctx)

    if (ctx.functionName === 'tryAdd') {
      span._spanContext._name = 'azure.eventhubs.create'
      span.setTag('messaging.operation', 'create')

      if (ctx.eventData.messageID !== undefined) {
        span.setTag('message.id', ctx.eventData.messageID)
      }

      if (batchLinksAreEnabled()) {
        ctx.batch._spanContexts.push(span.context())
        injectTraceContext(this.tracer, span, ctx.eventData)
      }
    }

    if (ctx.functionName === 'sendBatch') {
      const eventData = ctx.eventData
      const eventDataLength = eventData.length || eventData._context.connection._eventsCount
      span.setTag('messaging.operation', 'send')
      span.setTag('messaging.batch.message_count', eventDataLength)

      if (typeof (eventData) !== 'EventDataBatchImpl' && Array.isArray(eventData)) {
        eventData.forEach(event => {
          injectTraceContext(this.tracer, span, event)
        })
      } else {
        if (batchLinksAreEnabled()) {
          eventData._spanContexts.forEach(spanContext => {
            span.addLink(spanContext)
          })
        }
      }
    }

    return ctx.currentStore
  }

  asyncEnd (ctx) {
    super.finish()
  }
}

function injectTraceContext (tracer, span, event) {
  if (!event.properties) {
    event.properties = {}
  }
  tracer.inject(span, 'text_map', event.properties)
}

function batchLinksAreEnabled () {
  const eh = getEnvironmentVariable('DD_TRACE_AZURE_EVENTHUBS_BATCH_LINKS_ENABLED')
  return  eh !== 'false'
}

module.exports = AzureEventHubsProducerPlugin
