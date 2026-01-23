'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

class BaseLanggraphInternalPlugin extends TracingPlugin {
  static id = 'langgraph'
  static prefix = 'tracing:orchestrion:@langchain/langgraph:Pregel_invoke'

  bindStart (ctx) {
    this.startSpan('langgraph.invoke', {
      service: this.config.service,
      kind: 'internal',
      meta: {
        component: 'langgraph',
        'span.kind': 'internal'
      }
    }, ctx)

    return ctx.currentStore
  }

  asyncEnd (ctx) {
    this.finish(ctx)
  }

  finish (ctx) {
    // CRITICAL GUARD - DO NOT REMOVE: Ensures span only finishes when operation completes
    if (!ctx.hasOwnProperty('result') && !ctx.hasOwnProperty('error')) return

    // Tag error on span before finishing
    if (ctx.error) {
      this.addError(ctx.error, ctx.currentStore?.span)
    }

    super.finish(ctx)
  }
}

class PregelStreamPlugin extends BaseLanggraphInternalPlugin {
  static prefix = 'tracing:orchestrion:@langchain/langgraph:Pregel_stream'

  bindStart (ctx) {
    this.startSpan('langgraph.stream', {
      service: this.config.service,
      kind: 'internal',
      meta: {
        component: 'langgraph',
        'span.kind': 'internal'
      }
    }, ctx)

    return ctx.currentStore
  }
}

module.exports = {
  BaseLanggraphInternalPlugin,
  PregelStreamPlugin
}
