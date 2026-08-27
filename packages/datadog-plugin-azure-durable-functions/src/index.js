'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const { identityService, noServiceSource } = require('../../dd-trace/src/service-naming/helpers')

/** @type {import('../../dd-trace/src/plugins/tracing').NamingSchema} */
const namingSchema = {
  v0: {
    operationName: () => 'azure.functions.invoke',
    serviceName: identityService,
    serviceSource: noServiceSource,
  },
  v1: {
    operationName: () => 'azure.functions.invoke',
    serviceName: identityService,
    serviceSource: noServiceSource,
  },
}

class AzureDurableFunctionsPlugin extends TracingPlugin {
  static get id () { return 'azure-durable-functions' }
  static get operation () { return 'invoke' }
  static get prefix () { return 'tracing:datadog:azure:durable-functions:invoke' }
  static get type () { return 'serverless' }
  static get kind () { return 'server' }

  /** @override */
  getNamingSchema () {
    return namingSchema
  }

  bindStart (ctx) {
    const span = this.startSpan(this.operationName(), {
      kind: 'internal',
      type: 'serverless',

      meta: {
        component: 'azure-functions',
        'aas.function.name': ctx.functionName,
        'aas.function.trigger': ctx.trigger,
        'resource.name': `${ctx.trigger} ${ctx.functionName}`,
      },
    }, ctx)

    // in the case of entity functions, operationName should be available
    if (ctx.operationName) {
      span.setTag('aas.function.operation', ctx.operationName)
      span.setTag('resource.name', `${ctx.trigger} ${ctx.functionName} ${ctx.operationName}`
      )
    }

    ctx.span = span
    return ctx.currentStore
  }

  end (ctx) {
    // We only want to run finish here if this is a synchronous operation
    // Only synchronous operations would have `result` or `error` on `end`
    // So we skip operations that dont
    if (!ctx.hasOwnProperty('result') && !ctx.hasOwnProperty('error')) return
    super.finish(ctx)
  }

  asyncStart (ctx) {
    super.finish(ctx)
  }
}

module.exports = AzureDurableFunctionsPlugin
