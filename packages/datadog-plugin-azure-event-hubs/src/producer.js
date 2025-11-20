'use strict'

const ProducerPlugin = require('../../dd-trace/src/plugins/producer')

class AzureEventHubsProducerPlugin extends ProducerPlugin {
  static get id () { return 'azure-event-hubs' }
  static get operation () { return 'send' }
  static get prefix () { return 'tracing:apm:azure-event-hubs:send' }

  bindStart (ctx) {
    // we do not want to make these spans when batch linking is disabled.
    if (!this.batchLinksAreEnabled() && ctx.functionName === 'tryAdd') {
      return ctx.currentStore
    }

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

      if (this.batchLinksAreEnabled()) {
        ctx.batch._spanContexts.push(span.context())
        injectTraceContext(this.tracer, span, ctx.eventData)
      }
    }

    if (ctx.functionName === 'sendBatch') {
      const eventData = ctx.eventData
      const eventDataLength = eventData.length || eventData._context.connection._eventsCount
      span.setTag('messaging.operation', 'send')
      span.setTag('messaging.batch.message_count', eventDataLength)

      if (eventData.constructor.name !== 'EventDataBatchImpl' && Array.isArray(eventData)) {
        eventData.forEach(event => {
          injectTraceContext(this.tracer, span, event)
        })
      } else {
        if (this.batchLinksAreEnabled()) {
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

  batchLinksAreEnabled () {
    return this._tracerConfig?.trace?.azure?.eventHubs?.batchLinksEnabled !== false
  }
}

function injectTraceContext (tracer, span, event) {
  if (!event.properties) {
    event.properties = {}
  }
  tracer.inject(span, 'text_map', event.properties)
}

module.exports = AzureEventHubsProducerPlugin
