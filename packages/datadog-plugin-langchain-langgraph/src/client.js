'use strict'

const ClientPlugin = require('../../dd-trace/src/plugins/client')

class BaseLangchainLanggraphClientPlugin extends ClientPlugin {
  static id = 'langchain-langgraph'
  static prefix = 'tracing:orchestrion:@langchain/langgraph:Pregel_invoke'

  bindStart (ctx) {
    const meta = this.getTags(ctx)

    this.startSpan('invoke', {
      service: this.serviceName({ pluginService: this.config.service }),
      meta
    }, ctx)

    return ctx.currentStore
  }

  getTags (ctx) {
    return {
      component: 'langchain-langgraph',
      'span.kind': 'client'
    }
  }

  // asyncEnd and end delegate to finish() which has the required guard
  asyncEnd (ctx) {
    this.finish(ctx)
  }

  end (ctx) {
    this.finish(ctx)
  }

  // You may modify this method, but the guard below is REQUIRED and MUST NOT be removed!
  finish (ctx) {
    // CRITICAL GUARD - DO NOT REMOVE: Ensures span only finishes when operation completes
    if (!ctx.hasOwnProperty('result') && !ctx.hasOwnProperty('error')) return

    super.finish(ctx)
  }
}

class PregelStreamIteratorPlugin extends BaseLangchainLanggraphClientPlugin {
  static prefix = 'tracing:orchestrion:@langchain/langgraph:Pregel__streamIterator'
}

module.exports = {
  'BaseLangchainLanggraphClientPlugin': BaseLangchainLanggraphClientPlugin,
  'PregelStreamIteratorPlugin': PregelStreamIteratorPlugin
}
