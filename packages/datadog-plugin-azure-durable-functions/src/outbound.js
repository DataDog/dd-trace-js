'use strict'

// const TracingPlugin = require('../dd-trace/src/plugins/tracing')
const OutboundPlugin = require('../../dd-trace/src/plugins/outbound')
const log = require('../../dd-trace/src/log')

// const spanContexts = new WeakMap()

// class AzureDurableFunctionsOutboundPlugin extends TracingPlugin {
class AzureDurableFunctionsOutboundPlugin extends OutboundPlugin {
  static get id () { return 'azure-durable-functions' }
  static get operation () { return 'invoke' }
  static get prefix () { return 'tracing:apm:azure-durable-functions:invoke' }

  bindStart (ctx) {
    /* eslint-disable no-console */

    console.log('OLIVIER')
    log.debug('logging context:\n')
    for (const key in ctx) {
      /* eslint-disable-next-line */
      log.debug(`key: ${key}, val: ${ctx[key]}\n`)
    }
  }

  asyncEnd (ctx) {
    super.finish(ctx)
  }

  end (ctx) {
    super.finish(ctx)
  }
}

module.exports = AzureDurableFunctionsOutboundPlugin
