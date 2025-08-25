'use strict'

const ProducerPlugin = require('../../dd-trace/src/plugins/producer')

class AzureEventHubsProducerPlugin extends ProducerPlugin {
  static get id () { return 'azure-event-hubs' }
  static get operation () { return 'send' }
  static get prefix () { return 'tracing:apm:azure-event-hubs:send' }

  bindStart (ctx) {
    // We cannot inject trace context into a batch due to encoding
    // We must add it when a message is added to the batch
    if (ctx.functionName === 'tryAdd') {
      injectTraceContext(this._tracer, this.activeSpan, ctx.eventData)
    }

    if (ctx.functionName === 'sendBatch') {
      const eventType = getEventType(ctx)

      if (eventType === 'single') {
        // single event sends are possible but not officially supported in the SDK so we should skip it
        return ctx.currentStore
      }

      if (eventType === 'batch') {
        const eventHubConfig = ctx.eventData._context.config
        const qualifiedNamespace = eventHubConfig.endpoint.replace('sb://', '').replace('/', '')

        this.startSpan({
          resource: eventHubConfig.entityPath,
          type: 'messaging',
          meta: {
            component: 'azure-event-hubs',
            'messaging.operation': 'send',
            'messaging.system': 'eventhubs',
            'messaging.destination.name': eventHubConfig.entityPath,
            'network.destination.name': qualifiedNamespace,
          }
        }, ctx)

      } else {
        const span = this.startSpan({
          resource: 'EventHub',
          type: 'messaging',
          meta: {
            component: 'azure-event-hubs',
            'messaging.operation': 'send',
            'messaging.system': 'eventhubs',
          }
        }, ctx)

        ctx.eventData.forEach(event => {
          injectTraceContext(this._tracer, span, event)
        })
      }
    }
    return ctx.currentStore
  }

  asyncEnd (ctx) {
    super.finish()
  }
}

function getEventType (ctx) {
  if (ctx.eventData._context) {
    return 'batch'
  }

  if (Array.isArray(ctx.eventData)) {
    return 'array'
  }
  return 'single'
}

function injectTraceContext (tracer, span, event) {
  if (!event.properties) {
    event.properties = {}
  }
  tracer.inject(span, 'text_map', event.properties)
}

module.exports = AzureEventHubsProducerPlugin
