'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
class PregelStreamPlugin extends TracingPlugin {
  static id = 'langgraph'
  static prefix = 'tracing:orchestrion:@langchain/langgraph:Pregel_stream'

  bindStart (ctx) {
    this.startSpan('LangGraph', {
      service: this.config.service,
      kind: 'internal',
      component: 'langgraph',
    }, ctx)
    return ctx.currentStore
  }
}
class NextStreamPlugin extends PregelStreamPlugin {
  static id = 'langgraph'
  static prefix = 'tracing:orchestrion:@langchain/langgraph:Pregel_stream_next'

  bindStart (ctx) {
    return ctx.currentStore
  }

  asyncEnd (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return
    if (ctx.result.done === true) {
      span.finish()
    }
  }

  error (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return
    if (span) {
      this.addError(ctx?.error, span)
    }
    span.finish()
  }
}

module.exports = {
  PregelStreamPlugin,
  NextStreamPlugin,
}
