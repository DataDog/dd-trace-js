'use strict'

const ProducerPlugin = require('../../dd-trace/src/plugins/producer')

class AzureServiceBusProducerPlugin extends ProducerPlugin {
  static get id () { return 'azure-service-bus' }
  static get operation () { return 'send' }

  bindStart (ctx) {
    const span = this.startSpan({
      resource: `send ${ctx.entityPath || 'serviceBusQueue'}`,
      meta: {
        component: 'azure-service-bus',
      }
    }, ctx)

    // This is the correct key for injecting trace context into Azure Service Bus messages
    // It may not be present in the message properties, so we ensure it exists
    if (!ctx.msg.applicationProperties) {
      ctx.msg.applicationProperties = {}
    }

    this.tracer.inject(span, 'text_map', ctx.msg.applicationProperties)

    return ctx.currentStore
  }
}

module.exports = AzureServiceBusProducerPlugin
