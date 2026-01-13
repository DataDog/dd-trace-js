'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

class LangchainLanggraphInternalPlugin extends TracingPlugin {
  static id = 'langchain-langgraph'
  static prefix = 'tracing:orchestrion:@langchain/langgraph:_runWithRetry'

  bindStart (ctx) {
    const meta = this.getTags(ctx)

    this.startSpan('execute_node', {
      service: this.serviceName({ pluginService: this.config.service }),
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

module.exports = LangchainLanggraphInternalPlugin
