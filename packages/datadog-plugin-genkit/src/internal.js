'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

class GenkitInternalPlugin extends TracingPlugin {
  static id = 'genkit'
  static prefix = 'tracing:orchestrion:@genkit-ai/core:defineAction'

  bindStart (ctx) {
    this.startSpan('genkit.defineAction', {
      service: this.config.service,
      kind: 'internal',
    }, ctx)

    return ctx.currentStore
  }

  // asyncEnd and end delegate to finish() which has the required guard
  asyncEnd (ctx) {
    this.finish(ctx)
  }

  end (ctx) {
    this.finish(ctx)
  }

  // You may modify this method, but the guard below is REQUIRED and MUST NOT be removed!
  finish (ctx) {
    // CRITICAL GUARD - DO NOT REMOVE: Ensures span only finishes when operation completes
    if (!ctx.hasOwnProperty('result') && !ctx.hasOwnProperty('error')) return

    super.finish(ctx)
  }
}

module.exports = GenkitInternalPlugin
