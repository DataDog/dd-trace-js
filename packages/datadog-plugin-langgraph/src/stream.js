'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

class NextStreamPlugin extends TracingPlugin {
  static id = 'langgraph'
  static prefix = 'tracing:orchestrion:@langchain/langgraph:Pregel_stream:next'

  bindStart (ctx) {
    console.log('bindStart', ctx)
    this.startSpan('langgraph.stream.next', {
      service: this.config.service,
    }, ctx)

    return ctx.currentStore
  }
}

module.exports = NextStreamPlugin
