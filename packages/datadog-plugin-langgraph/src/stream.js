'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const { spanHasError } = require('../../dd-trace/src/llmobs/util')

// We are only tracing Pregel.stream because Pregel.invoke calls stream internally resulting in
// a graph with spans that look redundant.
class PregelStreamPlugin extends TracingPlugin {
  static id = 'langgraph_pregel_stream'
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
class NextStreamPlugin extends TracingPlugin {
  static id = 'langgraph_stream_next'
  static prefix = 'tracing:orchestrion:@langchain/langgraph:Pregel_stream_next'

  bindStart (ctx) {
    return ctx.currentStore
  }

  asyncEnd (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return
    if (ctx.result.done === true || spanHasError(span)) {
      span.finish()
    }
  }
}

module.exports = [
  PregelStreamPlugin,
  NextStreamPlugin,
]
