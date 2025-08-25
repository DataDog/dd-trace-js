'use strict'

const { send } = require('process')
const ProducerPlugin = require('../../dd-trace/src/plugins/producer')

class AzureEventHubsProducerPlugin extends ProducerPlugin {
  static get id () { return 'azure-event-hubs' }
  static get operation () { return 'send' }
  static get prefix () { return 'tracing:apm:azure-event-hubs:send' }

  bindStart (ctx) {
    // We cannot inject trace context into a batch due to encoding
    // We must add it when a message is added to the batch
    if (ctx.functionName === 'tryAdd') {
      injectTraceContext(this._tracer, ctx.span, ctx.eventData)
    }

    if (ctx.functionName === 'sendBatch') {

      const span = this.startSpan({
        type: 'messaging',
        meta: {
          component: 'azure-event-hubs',
          'messaging.operation': 'send',
          'messaging.system': 'eventhubs',
        }
      }, ctx)

      const eventType = getEventType(ctx)
      console.log("This is the event type: " + eventType)
      switch (eventType) {
        case 'batch':
          const config = ctx.eventData._context.config
          let qualifiedSenderNamespace = config.endpoint.replace('sb://', '')
          qualifiedSenderNamespace = qualifiedSenderNamespace.replace('/', '')
          span.resource = config.entityPath
          span.meta = { ...span.meta,
            'messaging.destination.name': config.entityPath,
            'network.destination.name': qualifiedSenderNamespace,
            'peer.service': qualifiedSenderNamespace
          }
          break;
        case 'array':
          span.resource = 'EventHub'
          console.log("This is the event data: " + ctx.eventData)
          ctx.eventData.forEach(event => {
            injectTraceContext(this._tracer, span, event)
          })
          break;
        case 'single':
          span.resource = 'EventHub'
          injectTraceContext(this._tracer, span, ctx.eventData)
          break;
      }
    return ctx.currentStore
    }
  }

  asyncEnd (ctx) {
    super.finish()
  }
}

function getEventType (ctx) {
  if (ctx.eventData.constructor.name === 'EventDataBatchImpl') {
    return 'batch'
  } else if (Array.isArray(ctx.eventData)) {
    return 'array'
  } else {
    return 'single'
  }
}

function injectTraceContext(tracer, span, event) {
  if (!event.properties) {
    event.properties = {}
  }
  tracer.inject(span, 'text_map', event.properties)
}


module.exports = AzureEventHubsProducerPlugin
