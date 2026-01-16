'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

class BaseLanggraphClientPlugin extends TracingPlugin {
  static id = '@langchain/langgraph'
  static prefix = 'tracing:orchestrion:@langchain/langgraph:Pregel_invoke'

  bindStart (ctx) {
    const meta = this.getTags(ctx)

    this.startSpan('langgraph.invoke', {
      service: this.config.service,
      kind: 'client',
      meta
    }, ctx)

    return ctx.currentStore
  }

  getTags (ctx) {
    return {
      component: '@langchain/langgraph',
      'span.kind': 'client'
    }
  }

  asyncEnd (ctx) {
    this.finish(ctx)
  }

  finish (ctx) {
    if (!ctx.hasOwnProperty('result') && !ctx.hasOwnProperty('error')) return

    super.finish(ctx)
  }
}

module.exports = BaseLanggraphClientPlugin
