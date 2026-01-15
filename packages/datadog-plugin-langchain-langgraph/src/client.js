'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

class BaseLanggraphPlugin extends TracingPlugin {
  finish (ctx) {
    if (!ctx.hasOwnProperty('result') && !ctx.hasOwnProperty('error')) return

    super.finish(ctx)
  }
}

class BaseLangchainLanggraphClientPlugin extends BaseLanggraphPlugin {
  static id = 'langchain-langgraph'
  static prefix = 'tracing:orchestrion:@langchain/langgraph:Pregel_invoke'

  asyncEnd (ctx) {
    this.finish(ctx)
  }

  bindStart (ctx) {
    this.startSpan('langchain-langgraph.invoke', {
      service: this.config.service,
      kind: 'client',
      meta: {
        component: 'langchain-langgraph',
        'span.kind': 'client'
      }
    }, ctx)

    return ctx.currentStore
  }
}

class PregelStreamPlugin extends BaseLanggraphPlugin {
  static id = 'langchain-langgraph'
  static prefix = 'apm:langchain-langgraph:stream'

  bindStart (ctx) {
    this.startSpan('langchain-langgraph.stream', {
      service: this.config.service,
      kind: 'client',
      meta: {
        component: 'langchain-langgraph',
        'span.kind': 'client'
      }
    }, ctx)

    return ctx.currentStore
  }
}

module.exports = {
  BaseLangchainLanggraphClientPlugin,
  PregelStreamPlugin
}
