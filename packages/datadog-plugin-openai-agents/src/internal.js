'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

class BaseOpenaiAgentsInternalPlugin extends TracingPlugin {
  static id = 'openai_agents_runner_run'
  static prefix = 'tracing:orchestrion:@openai/agents-core:Runner_run'

  bindStart (ctx) {
    const meta = {
      component: 'openai-agents',
      'span.kind': 'internal'
    }

    // Extract agent name and configuration from arguments
    // Runner.run signature: run(agent, input, options)
    const agent = ctx.arguments?.[0]
    if (agent) {
      if (agent.name) {
        meta['openai-agents.agent.name'] = agent.name
      }
      if (agent.tools && Array.isArray(agent.tools)) {
        const toolNames = agent.tools.map(t => t.name || 'unknown').join(', ')
        if (toolNames) {
          meta['openai-agents.tools'] = toolNames
        }
      }
    }

    this.startSpan('openai-agents.run', {
      service: this.config.service,
      kind: 'internal',
      meta
    }, ctx)

    return ctx.currentStore
  }

  asyncEnd (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    if (ctx.result?.state?._currentTurn !== undefined) {
      span.setTag('openai-agents.turn_count', String(ctx.result.state._currentTurn))
    }

    super.finish(ctx)
  }
}

class FunctionToolInvokePlugin extends TracingPlugin {
  static id = 'openai_agents_tool_invoke'
  static prefix = 'tracing:orchestrion:@openai/agents-core:FunctionTool_invoke'

  asyncStart (ctx) {
    const meta = {
      component: 'openai-agents',
      'span.kind': 'internal'
    }

    // Extract tool name from the FunctionTool instance
    const tool = ctx.self
    if (tool?.name) {
      meta['openai-agents.tool.name'] = tool.name
    }

    // Extract input parameters from arguments
    // Arguments are: [runContext, input, details]
    if (ctx.arguments && ctx.arguments[1]) {
      try {
        const inputStr = typeof ctx.arguments[1] === 'string'
          ? ctx.arguments[1]
          : JSON.stringify(ctx.arguments[1])
        meta['openai-agents.tool.input'] = inputStr
      } catch {
        // Skip if serialization fails
      }
    }

    this.startSpan('openai-agents.invoke', {
      service: this.config.service,
      kind: 'internal',
      meta
    }, ctx)
  }

  asyncEnd (ctx) {
    super.finish(ctx)
  }
}

module.exports = [
  BaseOpenaiAgentsInternalPlugin,
  FunctionToolInvokePlugin
]
