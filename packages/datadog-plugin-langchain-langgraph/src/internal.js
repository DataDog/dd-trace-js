'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

class LangchainLanggraphInternalPlugin extends TracingPlugin {
  static id = 'langchain-langgraph'
  static prefix = 'tracing:orchestrion:@langchain/langgraph:_runWithRetry'

  bindStart (ctx) {
    const meta = this.getTags(ctx)

    this.startSpan('langchain-langgraph._runWithRetry', {
      service: this.config.service,
      kind: 'internal',
      meta
    }, ctx)

    return ctx.currentStore
  }

  getTags (ctx) {
    return {
      component: 'langchain-langgraph',
      'span.kind': 'internal'
    }
  }

  asyncEnd (ctx) {
    this.finish(ctx)
  }

  end (ctx) {
    this.finish(ctx)
  }

  finish (ctx) {
    if (!ctx.hasOwnProperty('result') && !ctx.hasOwnProperty('error')) return

    super.finish(ctx)
  }
}

module.exports = LangchainLanggraphInternalPlugin
