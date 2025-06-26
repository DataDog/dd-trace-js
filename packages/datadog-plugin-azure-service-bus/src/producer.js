'use strict'

const ProducerPlugin = require('../../dd-trace/src/plugins/producer')

class AzureServiceBusProducerPlugin extends ProducerPlugin {
  static get id () { return 'azure-service-bus' }
  static get operation () { return 'send' }
  constructor (...args) {
    console.log("AzureServiceBusProducerPlugin loaded")
    super(...args)
  }

  bindStart (ctx) {
    console.log("AzureServiceBusProducerPlugin bindStart called with ctx:", ctx)
    const { targetAddress } = ctx
    const name = targetAddress || 'serviceBusQueue'
    this.startSpan({
      resource: name,
      meta: {
        component: 'azure-service-bus',
      }
    }, ctx)

    return ctx.currentStore
  }
}

module.exports = AzureServiceBusProducerPlugin
