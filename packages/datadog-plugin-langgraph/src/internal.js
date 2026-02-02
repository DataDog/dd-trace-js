'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

class BaseLanggraphInternalPlugin extends TracingPlugin {
  static id = 'langgraph'
  static prefix = 'tracing:orchestrion:@langchain/langgraph:Pregel_invoke'

  bindStart (ctx) {
    const meta = this.getTags(ctx)

    this.startSpan('langgraph.invoke', {
      service: this.config.service,
      meta,
    }, ctx)

    return ctx.currentStore
  }

  getTags (ctx) {
    return {
      component: 'langgraph',
      'span.kind': 'internal',
    }
  }

  asyncEnd (ctx) {
    this.finish(ctx)
  }

  // You may modify this method, but the guard below is REQUIRED and MUST NOT be removed!
  finish (ctx) {
    // CRITICAL GUARD - DO NOT REMOVE: Ensures span only finishes when operation completes
    if (!ctx.hasOwnProperty('result') && !ctx.hasOwnProperty('error')) return

    super.finish(ctx)
  }
}

class PregelStreamPlugin extends BaseLanggraphInternalPlugin {
  static prefix = 'tracing:orchestrion:@langchain/langgraph:Pregel_stream'

  bindStart (ctx) {
    const meta = this.getTags(ctx)

    this.startSpan('langgraph.stream', {
      service: this.config.service,
      meta,
    }, ctx)

    return ctx.currentStore
  }
}

module.exports = {
  BaseLanggraphInternalPlugin,
  PregelStreamPlugin,
}
