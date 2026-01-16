'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

class BaseOpenaiAgentsInternalPlugin extends TracingPlugin {
  static id = 'openai-agents'
  static prefix = 'tracing:@openai/agents:executeFunctionToolCalls'
  static spanName = 'openai-agents.executeFunctionToolCalls'

  bindStart (ctx) {
    this.startSpan(this.constructor.spanName, {
      meta: this.getTags(ctx)
    }, ctx)

    return ctx.currentStore
  }

  getTags (ctx) {
    return {
      component: 'openai-agents',
      'span.kind': 'internal',
      'ai.request.model': ctx.arguments?.[0]?.model,
      'ai.request.model_provider': 'openai',
      'openai.request.model': ctx.arguments?.[0]?.model
    }
  }
}

class ExecuteHandoffCallsPlugin extends BaseOpenaiAgentsInternalPlugin {
  static prefix = 'tracing:@openai/agents:executeHandoffCalls'
  static spanName = 'openai-agents.executeHandoffCalls'
}

module.exports = {
  BaseOpenaiAgentsInternalPlugin,
  ExecuteHandoffCallsPlugin
}
