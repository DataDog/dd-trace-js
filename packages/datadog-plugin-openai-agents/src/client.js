'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

class BaseOpenaiAgentsClientPlugin extends TracingPlugin {
  static id = 'openai-agents'

  bindStart (ctx) {
    this.startSpan(this.constructor.spanName, {
      service: this.config.service,
      meta: {
        component: 'openai-agents',
        'span.kind': 'client',
      },
    }, ctx)

    return ctx.currentStore
  }

  asyncEnd (ctx) {
    this.finish(ctx)
  }

  end (ctx) {
    this.finish(ctx)
  }

  finish (ctx) {
    // Both end and asyncEnd fire for async orchestrion spans; skip the early
    // end event (no result/error yet) so the span finishes only on asyncEnd.
    if (!ctx.hasOwnProperty('result') && !ctx.hasOwnProperty('error')) return

    super.finish(ctx)
  }
}

class GetStreamedResponsePlugin extends BaseOpenaiAgentsClientPlugin {
  static prefix = 'tracing:orchestrion:@openai/agents-openai:getStreamedResponse'
  static spanName = 'openai-agents.getStreamedResponse'
}

class GetResponsePlugin extends BaseOpenaiAgentsClientPlugin {
  static prefix = 'tracing:orchestrion:@openai/agents-openai:getResponse'
  static spanName = 'openai-agents.getResponse'
}

module.exports = [GetStreamedResponsePlugin, GetResponsePlugin]
