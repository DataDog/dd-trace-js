'use strict'

// const TracingPlugin = require('../dd-trace/src/plugins/tracing')
const OutboundPlugin = require('../../dd-trace/src/plugins/outbound')
const log = require('../../dd-trace/src/log')

// const spanContexts = new WeakMap()

// class AzureDurableFunctionsOutboundPlugin extends TracingPlugin {
class AzureDurableFunctionsOutboundPlugin extends OutboundPlugin {
  static get id () { return 'azure-durable-functions' }
  static get operation () { return 'invoke' }
  static get prefix () { return 'tracing:datadog:azure:durable-functions:invoke' }

  bindStart (ctx) {
    log.debug('in durable-functions plugin for method: %s', ctx.methodName)
    // const span =
    this.startSpan(this.operationName(), {
      meta: {
        component: 'azure-durable-functions',
      },
    })
  }

  asyncEnd (ctx) {
    super.finish(ctx)
  }

  end (ctx) {
    super.finish(ctx)
  }
}

module.exports = AzureDurableFunctionsOutboundPlugin
