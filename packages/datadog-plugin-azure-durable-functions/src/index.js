'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

class AzureDurableFunctionsPlugin extends TracingPlugin {
  static get id () { return 'azure-durable-functions' }
  static get operation () { return 'invoke' }
  static get prefix () { return 'tracing:datadog:azure:durable-functions:invoke' }
  static get type () { return 'serverless' }
  static get kind () { return 'server' }

  bindStart (ctx) {
    const span = this.startSpan(this.operationName(), {
      kind: 'internal',

      meta: {
        component: 'azure-durable-functions',
        'aas.function.name': ctx.functionName,
        'aas.function.trigger': ctx.trigger,
        'resource.name': `${ctx.trigger} ${ctx.functionName}`,
      },
    }, ctx)

    ctx.span = span
    return ctx.currentStore
  }

  asyncEnd (ctx) {
    super.finish(ctx)
  }

  end (ctx) {
    super.finish(ctx)
  }
}

module.exports = AzureDurableFunctionsPlugin
