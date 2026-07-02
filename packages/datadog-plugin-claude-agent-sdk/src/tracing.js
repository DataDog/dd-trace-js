'use strict'

const { storage } = require('../../datadog-core')
const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const { splitModel } = require('./util')

class QueryTracingPlugin extends TracingPlugin {
  static id = 'claude_agent_sdk_query'
  static operation = 'turn'
  static system = 'claude-agent-sdk'
  static prefix = 'tracing:orchestrion:@anthropic-ai/claude-agent-sdk:query'

  bindStart (ctx) {
    console.log('new query span')
    this.startSpan('claude_agent_sdk.query', {
      meta: { 'resource.name': 'claude_agent_sdk.query' },
      startTime: ctx.startTime,
    }, ctx)
    ctx.runInContext = fn => storage('legacy').run(ctx.currentStore, fn)
    return ctx.currentStore
  }

  asyncEnd (ctx) {
    if (!ctx.streamResolved) return
    console.log('finishing query span')

    ctx.currentStore?.span?.finish(ctx.finishTime)
  }
}

class StepTracingPlugin extends TracingPlugin {
  static id = 'claude_agent_sdk_step'
  static operation = 'step'
  static system = 'claude-agent-sdk'
  static prefix = 'tracing:apm:claude-agent-sdk:step'

  bindStart (ctx) {
    console.log('new step span', ctx.stepIndex)
    this.startSpan(`step-${ctx.stepIndex}`, {
      meta: { 'resource.name': 'claude_agent_sdk.step' },
      startTime: ctx.startTime,
    }, ctx)

    return ctx.currentStore
  }

  end (ctx) {
    console.log('finishing step span', ctx.stepIndex)
    ctx.currentStore?.span?.finish(ctx.finishTime)
  }
}

class ToolTracingPlugin extends TracingPlugin {
  static id = 'claude_agent_sdk_tool'
  static operation = 'tool'
  static system = 'claude-agent-sdk'
  static prefix = 'tracing:apm:claude-agent-sdk:tool'

  bindStart (ctx) {
    const toolName = ctx.name || 'claude_agent_sdk.tool'

    console.log('new tool span', toolName)

    this.startSpan(toolName, {
      meta: { 'resource.name': 'claude_agent_sdk.tool' },
      startTime: ctx.startTime,
    }, ctx)

    return ctx.currentStore
  }

  end (ctx) {
    console.log('finishing tool span', ctx.name)
    ctx.currentStore?.span?.finish(ctx.finishTime)
  }
}

class LlmTracingPlugin extends TracingPlugin {
  static id = 'claude_agent_sdk_llm'
  static operation = 'llm'
  static system = 'claude-agent-sdk'
  static prefix = 'tracing:apm:claude-agent-sdk:llm'

  bindStart (ctx) {
    const { model } = ctx

    console.log('new llm span', model)

    const { modelName, modelProvider } = splitModel(model)
    const name = modelName || 'claude_agent_sdk.llm'

    this.startSpan(name, {
      meta: {
        'resource.name': 'claude_agent_sdk.llm',
        'claude-agent-sdk.request.model_name': modelName,
        'claude-agent-sdk.request.model_provider': modelProvider,
      },
      startTime: ctx.startTime,
    }, ctx)

    return ctx.currentStore
  }

  end (ctx) {
    console.log('finishing llm span', ctx.model)
    ctx.currentStore?.span?.finish(ctx.finishTime)
  }
}

module.exports = [
  QueryTracingPlugin,
  StepTracingPlugin,
  ToolTracingPlugin,
  LlmTracingPlugin,
]
