'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const { NextStreamPlugin, PregelStreamPlugin } = require('./stream')
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
    const span = ctx.currentStore?.span
    if (!span) return
    span.finish()
  }
}

module.exports = {
  BaseLanggraphInternalPlugin,
  PregelStreamPlugin,
  NextStreamPlugin,
}
