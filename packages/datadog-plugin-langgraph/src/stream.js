'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

class LanggraphStreamPlugin extends TracingPlugin {
  static id = '@langchain/langgraph'
  // Use shimmer-based channel (not orchestrion rewriter)
  static prefix = 'apm:langgraph:stream'

  bindStart (ctx) {
    const meta = this.getTags(ctx)

    this.startSpan('langgraph.stream', {
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

module.exports = LanggraphStreamPlugin
