'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

class BaseOpenaiAgentsInternalPlugin extends TracingPlugin {
  static id = 'openai-agents'
  static prefix = 'tracing:orchestrion:@openai/agents-core:run'
  static spanName = 'openai-agents.run'

  bindStart (ctx) {
    const meta = this.getTags(ctx)

    this.startSpan(this.constructor.spanName, {
      service: this.config.service,
      meta,
    }, ctx)

    return ctx.currentStore
  }

  /**
   * @param {{ args?: Array<unknown> }} ctx - The orchestrion context with function arguments
   * @returns {object} Span tags
   */
  getTags (ctx) {
    const tags = {
      component: 'openai-agents',
      'span.kind': 'internal',
    }

    const agentName = ctx.args?.[0]?.name
    if (agentName) {
      tags['resource.name'] = agentName
    }

    return tags
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
  // Inherits prefix and spanName from BaseOpenaiAgentsInternalPlugin for the run channel
}

class InvokeFunctionToolPlugin extends BaseOpenaiAgentsInternalPlugin {
  static prefix = 'tracing:orchestrion:@openai/agents-core:invokeFunctionTool'
  static spanName = 'openai-agents.invokeFunctionTool'

  getTags (ctx) {
    const tags = {
      component: 'openai-agents',
      'span.kind': 'internal',
    }

    const toolName = ctx.args?.[0]?.tool?.name
    if (toolName) {
      tags['resource.name'] = toolName
    }

    return tags
  }
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

module.exports = {
  RunPlugin,
  InvokeFunctionToolPlugin,
  OnInvokeHandoffPlugin,
  RunToolInputGuardrailsPlugin,
  RunToolOutputGuardrailsPlugin,
}
