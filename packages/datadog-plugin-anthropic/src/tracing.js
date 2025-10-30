'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

class AnthropicTracingPlugin extends TracingPlugin {
  static id = 'anthropic'
  static operation = 'request'
  static system = 'anthropic'
  static prefix = 'tracing:apm:anthropic:request'

  bindStart (ctx) {
    const { resource, options } = ctx

    this.startSpan('anthropic.request', {
      meta: {
        'resource.name': `Messages.${resource}`,
        'anthropic.request.model': options.model
      }
    }, ctx)

    return ctx.currentStore
  }

  asyncEnd (ctx) {
    const span = ctx.currentStore?.span
    span?.finish()
  }
}

module.exports = AnthropicTracingPlugin
