'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const log = require('../../dd-trace/src/log')

class AzureDurableFunctionsPlugin extends TracingPlugin {
  static get id () { return 'azure-durable-functions' }
  static get operation () { return 'invoke' }
  static get prefix () { return 'tracing:datadog:azure:durable-functions:invoke' }
  static get type () { return 'serverless' }
  static get kind () { return 'server' }

  bindStart (ctx) {
    log.debug('in durable-functions plugin for method: %s. ctx:\n%o ', ctx.methodName, ctx)
    // Object.entries(ctx).forEach(([key, value]) => {
    //   log.debug('{ %s: %o }', key, value)
    // })
    // const span =

    // const opName = this.operationName()
    // console.log('opname in azdurable:', opName)

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
    log.debug('async end in durable-functions plugin for method: %s', ctx.methodName)
    super.finish(ctx)
  }

  end (ctx) {
    log.debug('end in durable-functions plugin for method: %s', ctx.methodName)
    super.finish(ctx)
  }
}

module.exports = AzureDurableFunctionsPlugin
