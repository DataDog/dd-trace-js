'use strict'

const ProducerPlugin = require('../../dd-trace/src/plugins/producer')

class AzureEventHubsProducerPlugin extends ProducerPlugin {
  static get id () { return 'azure-event-hubs' }
  static get operation () { return 'send' }
  static get prefix () { return 'tracing:apm:azure-event-hubs:send' }

  bindStart (ctx) {

    if (ctx.functionName === 'tryAdd') {
      injectTraceContext(this._tracer, this.activeSpan, ctx.eventData)
    }

    // only batch and array eventTypes are supported by the Azure Event Hubs SDK
    if (ctx.functionName === 'sendBatch' && eventType(ctx) !== 'single') {

      const qualifiedNamespace = ctx.config.endpoint.replace('sb://', '').replace('/', '')
      const entityPath = ctx.config.entityPath
      const span = this.startSpan({
        resource: entityPath,
        type: 'messaging',
        meta: {
          component: 'azure-event-hubs',
          'messaging.operation': 'send',
          'messaging.system': 'eventhubs',
          'messaging.destination.name': entityPath,
          'network.destination.name': qualifiedNamespace,
        }
      }, ctx)

      if (eventType(ctx) === 'array') {
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

function eventType (ctx) {
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
