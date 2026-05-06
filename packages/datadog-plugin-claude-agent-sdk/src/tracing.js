'use strict'

const { spanHasError } = require('../../dd-trace/src/llmobs/util')
const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

class SessionTracingPlugin extends TracingPlugin {
  static id = 'claude_agent_sdk_session'
  static prefix = 'tracing:orchestrion:@anthropic-ai/claude-agent-sdk:query'

  bindStart (ctx) {
    this.startSpan('starting session', {
      meta: { 'resource.name': 'session' },
    }, ctx)
    return ctx.currentStore
  }
}

class SessionTracingPluginNext extends TracingPlugin {
  static id = 'claude_agent_sdk_session_next'
  static prefix = 'tracing:orchestrion:@anthropic-ai/claude-agent-sdk:query_next'

  bindStart (ctx) {
    return ctx.currentStore
  }

  asyncEnd (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return
    if (ctx.result.done === true || spanHasError(span)) {
      span.finish()
    }
  }
}

class TurnTracingPlugin extends TracingPlugin {
  static id = 'claude_agent_sdk_turn'
  static operation = 'turn'
  static system = 'claude-agent-sdk'
  static prefix = 'tracing:apm:claude-agent-sdk:turn'

  bindStart (ctx) {
    this.startSpan('turn', {
      meta: { 'resource.name': 'turn' },
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
      meta: { 'resource.name': name },
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
    const name = ctx.agentType ? `subagent-${ctx.agentType}` : 'subagent'
    this.startSpan(name, {
      meta: { 'resource.name': name },
    }, ctx)
    return ctx.currentStore
  }

  asyncEnd (ctx) {
    ctx.currentStore?.span?.finish()
  }
}

module.exports = [
  SessionTracingPlugin,
  SessionTracingPluginNext,
  TurnTracingPlugin,
  ToolTracingPlugin,
  SubagentTracingPlugin,
]
