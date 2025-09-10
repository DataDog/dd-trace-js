'use strict'

const ProducerPlugin = require('../../dd-trace/src/plugins/producer')

class AzureEventHubsProducerPlugin extends ProducerPlugin {
  static get id () { return 'azure-event-hubs' }
  static get operation () { return 'send' }
  static get prefix () { return 'tracing:apm:azure-event-hubs:send' }
  // list of spans created from tryAdd calls. used for span links when sending a batch
  batch = []

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
      this.batch.push(span)
      injectTraceContext(this.tracer, span, ctx.eventData)
    }

    if (ctx.functionName === 'sendBatch') {
      const eventData = ctx.eventData
      span.setTag('messaging.operation', 'send')
      span.setTag('messaging.batch.message_count', eventData.length)
      //batch is an array in this case and not from tryAdd
      if (this.batch.length === 0 && Array.isArray(eventData)) {
        eventData.forEach(event => {
          injectTraceContext(this.tracer, span, event)
        })
      } else {
        this.batch.forEach(tryAddSpan => {
          span.addLink(tryAddSpan.context())
        })
        this.batch = []
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

module.exports = AzureEventHubsProducerPlugin
