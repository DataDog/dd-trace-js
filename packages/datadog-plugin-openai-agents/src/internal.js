'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

class BaseOpenaiAgentsInternalPlugin extends TracingPlugin {
  static id = 'openai-agents'

  bindStart (ctx) {
    this.startSpan(this.constructor.spanName, {
      service: this.config.service,
      meta: {
        component: 'openai-agents',
        'span.kind': 'internal',
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

class RunPlugin extends BaseOpenaiAgentsInternalPlugin {
  static prefix = 'tracing:orchestrion:@openai/agents-core:run'
  static spanName = 'openai-agents.run'
}

class InvokeFunctionToolPlugin extends BaseOpenaiAgentsInternalPlugin {
  static prefix = 'tracing:orchestrion:@openai/agents-core:invokeFunctionTool'
  static spanName = 'openai-agents.invokeFunctionTool'
}

class OnInvokeHandoffPlugin extends BaseOpenaiAgentsInternalPlugin {
  static prefix = 'tracing:orchestrion:@openai/agents-core:onInvokeHandoff'
  static spanName = 'openai-agents.onInvokeHandoff'
}

class RunToolInputGuardrailsPlugin extends BaseOpenaiAgentsInternalPlugin {
  static prefix = 'tracing:orchestrion:@openai/agents-core:runToolInputGuardrails'
  static spanName = 'openai-agents.runInputGuardrails'
}

class RunToolOutputGuardrailsPlugin extends BaseOpenaiAgentsInternalPlugin {
  static prefix = 'tracing:orchestrion:@openai/agents-core:runToolOutputGuardrails'
  static spanName = 'openai-agents.runOutputGuardrails'
}

module.exports = [
  RunPlugin,
  InvokeFunctionToolPlugin,
  OnInvokeHandoffPlugin,
  RunToolInputGuardrailsPlugin,
  RunToolOutputGuardrailsPlugin,
]
