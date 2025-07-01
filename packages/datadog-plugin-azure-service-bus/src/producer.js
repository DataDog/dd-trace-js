'use strict'

const ProducerPlugin = require('../../dd-trace/src/plugins/producer')

class AzureServiceBusProducerPlugin extends ProducerPlugin {
  static get id () { return 'azure-service-bus' }
  static get operation () { return 'send' }

  bindStart (ctx) {
    const { sender, msg } = ctx
    const qualifiedSenderNamespace = sender._sender.audience.replace('sb://', '')
    const span = this.startSpan({
      resource: sender.entityPath,
      type: 'messaging',
      meta: {
        component: 'azure-service-bus',
        'messaging.destination.name': sender.entityPath,
        'messaging.operation': 'send',
        'messaging.system': 'servicebus',
        'network.destination.name': qualifiedSenderNamespace,
      }
    }, ctx)

    // This is the correct key for injecting trace context into Azure Service Bus messages
    // It may not be present in the message properties, so we ensure it exists
    if (!msg.applicationProperties) {
      msg.applicationProperties = {}
    }

    this.tracer.inject(span, 'text_map', msg.applicationProperties)

    return ctx.currentStore
  }
}

module.exports = AzureServiceBusProducerPlugin
