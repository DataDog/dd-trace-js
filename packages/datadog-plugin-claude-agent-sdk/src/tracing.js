'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

class TurnTracingPlugin extends TracingPlugin {
  static id = 'claude_agent_sdk_turn'
  static operation = 'turn'
  static system = 'claude-agent-sdk'
  static prefix = 'tracing:apm:claude-agent-sdk:turn'

  bindStart (ctx) {
    this.startSpan('claude_agent_sdk.query', {
      meta: { 'resource.name': 'claude_agent_sdk.query' },
    }, ctx)
    return ctx.currentStore
  }

  asyncEnd (ctx) {
    ctx.currentStore?.span?.finish()
  }
}

class ToolTracingPlugin extends TracingPlugin {
  static id = 'claude_agent_sdk_tool'
  static operation = 'tool'
  static system = 'claude-agent-sdk'
  static prefix = 'tracing:apm:claude-agent-sdk:tool'

  bindStart (ctx) {
    const name = ctx.toolName || 'tool'
    this.startSpan(name, {
      meta: { 'resource.name': 'claude_agent_sdk.tool' },
    }, ctx)
    return ctx.currentStore
  }

  asyncEnd (ctx) {
    ctx.currentStore?.span?.finish()
  }
}

class SubagentTracingPlugin extends TracingPlugin {
  static id = 'claude_agent_sdk_subagent'
  static operation = 'subagent'
  static system = 'claude-agent-sdk'
  static prefix = 'tracing:apm:claude-agent-sdk:subagent'

  bindStart (ctx) {
    const name = ctx.agentType || 'subagent'
    this.startSpan(name, {
      meta: { 'resource.name': 'claude_agent_sdk.subagent' },
    }, ctx)
    return ctx.currentStore
  }

  asyncEnd (ctx) {
    ctx.currentStore?.span?.finish()
  }
}

module.exports = [
  TurnTracingPlugin,
  ToolTracingPlugin,
  SubagentTracingPlugin,
]
