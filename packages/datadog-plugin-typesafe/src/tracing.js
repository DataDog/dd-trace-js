'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

class TypeSafeTracingPlugin extends TracingPlugin {
  static id = 'typesafe'
  static operation = 'request'
  static system = 'typesafe'
  static prefix = 'tracing:apm:typesafe:request'

  bindStart (ctx) {
    this.startSpan('typesafe.request', {
      meta: {
        'resource.name': 'TypeSafeClient.systemOne',
        'typesafe.request.model': ctx.request?.model ?? ctx.defaultModel,
      },
    }, ctx)

    return ctx.currentStore
  }

  asyncEnd (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    if (ctx.result?.model) span.setTag('typesafe.response.model', ctx.result.model)
    span.finish()
  }
}

module.exports = TypeSafeTracingPlugin
