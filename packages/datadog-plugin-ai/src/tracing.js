'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

class VercelAITracingPlugin extends TracingPlugin {
  static get id () { return 'ai' }
  static get prefix () { return 'tracing:dd-trace:vercel-ai' }

  bindStart (ctx) {
    this.startSpan(ctx.name, {
      meta: {
        'resource.name': ctx.name
      }
    }, ctx)

    return ctx.currentStore
  }

  asyncEnd (ctx) {
    const span = ctx.currentStore?.span
    span?.finish()
  }
}

module.exports = VercelAITracingPlugin
