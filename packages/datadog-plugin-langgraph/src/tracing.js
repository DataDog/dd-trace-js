'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

class LanggraphTracingPlugin extends TracingPlugin {
  bindStart (ctx) {
    this.startSpan(this.constructor.spanName, {
      service: this.config.service,
      kind: 'client',
      meta: {
        component: '@langchain/langgraph',
        'span.kind': 'client'
      }
    }, ctx)

    return ctx.currentStore
  }

  asyncEnd (ctx) {
    this.finish(ctx)
  }

  finish (ctx) {
    if (!ctx.hasOwnProperty('result') && !ctx.hasOwnProperty('error')) return

    super.finish(ctx)
  }
}

class LanggraphInvokePlugin extends LanggraphTracingPlugin {
  static id = 'langgraph_invoke'
  static prefix = 'tracing:orchestrion:@langchain/langgraph:Pregel_invoke'
  static spanName = 'langgraph.invoke'
}

class LanggraphStreamPlugin extends LanggraphTracingPlugin {
  static id = 'langgraph_stream'
  static prefix = 'tracing:apm:langgraph:stream'
  static spanName = 'langgraph.stream'
}

module.exports = {
  LanggraphInvokePlugin,
  LanggraphStreamPlugin
}
