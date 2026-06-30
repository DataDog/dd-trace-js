'use strict'

const { storage } = require('../../datadog-core')
const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

class QueryTracingPlugin extends TracingPlugin {
  static id = 'claude_agent_sdk_query'
  static operation = 'turn'
  static system = 'claude-agent-sdk'
  static prefix = 'tracing:orchestrion:@anthropic-ai/claude-agent-sdk:query'

  bindStart (ctx) {
    this.startSpan('claude_agent_sdk.query', {
      meta: { 'resource.name': 'claude_agent_sdk.query' },
      startTime: ctx.startTime,
    }, ctx)
    ctx.runInContext = fn => storage('legacy').run(ctx.currentStore, fn)
    return ctx.currentStore
  }

  asyncEnd (ctx) {
    if (!ctx.streamResolved) return

    ctx.currentStore?.span?.finish(ctx.finishTime)
  }
}

class StepTracingPlugin extends TracingPlugin {
  static id = 'claude_agent_sdk_step'
  static operation = 'step'
  static system = 'claude-agent-sdk'
  static prefix = 'tracing:apm:claude-agent-sdk:step'

  bindStart (ctx) {
    this.startSpan('claude_agent_sdk.step', {
      meta: { 'resource.name': `step-${ctx.stepIndex}` },
      startTime: ctx.startTime,
    }, ctx)

    return ctx.currentStore
  }

  end (ctx) {
    ctx.currentStore?.span?.finish(ctx.finishTime)
  }
}

class ToolTracingPlugin extends TracingPlugin {
  static id = 'claude_agent_sdk_tool'
  static operation = 'tool'
  static system = 'claude-agent-sdk'
  static prefix = 'tracing:apm:claude-agent-sdk:tool'

  bindStart (ctx) {
    this.startSpan('claude_agent_sdk.tool', {
      meta: { 'resource.name': ctx.name },
      startTime: ctx.startTime,
    }, ctx)

    return ctx.currentStore
  }

  end (ctx) {
    ctx.currentStore?.span?.finish(ctx.finishTime)
  }
}

class LlmTracingPlugin extends TracingPlugin {
  static id = 'claude_agent_sdk_llm'
  static operation = 'llm'
  static system = 'claude-agent-sdk'
  static prefix = 'tracing:apm:claude-agent-sdk:llm'

  bindStart (ctx) {
    this.startSpan('claude_agent_sdk.llm', {
      meta: { 'resource.name': ctx.model },
      startTime: ctx.startTime,
    }, ctx)

    return ctx.currentStore
  }

  end (ctx) {
    ctx.currentStore?.span?.finish(ctx.finishTime)
  }
}

module.exports = [
  QueryTracingPlugin,
  StepTracingPlugin,
  ToolTracingPlugin,
  LlmTracingPlugin,
]
