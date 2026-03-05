'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

class LangchainLanggraphInternalPlugin extends TracingPlugin {
  static id = 'langchain-langgraph'
  static prefix = 'tracing:orchestrion:@langchain/langgraph:Pregel_stream'

  bindStart (ctx) {
    const meta = this.getTags(ctx)

    this.startSpan('langchain-langgraph.stream', {
      service: this.config.service,
      meta,
    }, ctx)

    return ctx.currentStore
  }

  getTags (ctx) {
    return {
      component: 'langchain-langgraph',
      'span.kind': 'internal',
    }
  }

  // For AsyncIterator, the sync end fires before stream consumption completes.
  // Only finish in asyncEnd after the full async lifecycle (including errors).
  asyncEnd (ctx) {
    this.finish(ctx)
  }

  finish (ctx) {
    if (!ctx.hasOwnProperty('result') && !ctx.hasOwnProperty('error')) return

    super.finish(ctx)
  }
}

module.exports = LangchainLanggraphInternalPlugin
