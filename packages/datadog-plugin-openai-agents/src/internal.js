'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

class OpenaiAgentsRunPlugin extends TracingPlugin {
  static id = 'openai-agents'
  static prefix = 'tracing:orchestrion:@openai/agents-core:run'

  bindStart (ctx) {
    const meta = this.getTags(ctx)

    this.startSpan('openai-agents.run', {
      meta,
    }, ctx)

    return ctx.currentStore
  }

  getTags (ctx) {
    return {
      component: 'openai-agents',
      'span.kind': 'internal',
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

module.exports = {
  OpenaiAgentsRunPlugin,
}
