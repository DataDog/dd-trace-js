'use strict'

const ClientPlugin = require('../../dd-trace/src/plugins/client')

class BaseOpenaiAgentsClientPlugin extends ClientPlugin {
  static id = 'openai-agents'
  static prefix = 'tracing:@openai/agents:Runner_run'
  static spanName = 'openai-agents.run'

  // Define peer service precursor tags for OpenAI agents
  // This enables automatic peer.service computation from these tags
  static peerServicePrecursors = ['out.host', 'ai.request.model_provider']

  bindStart (ctx) {
    this.startSpan(this.constructor.spanName, {
      meta: this.getTags(ctx)
    }, ctx)

    return ctx.currentStore
  }

  getTags (ctx) {
    const model = ctx.arguments?.[0]?.model
    return {
      component: 'openai-agents',
      'span.kind': 'client',
      'ai.request.model': model,
      'ai.request.model_provider': 'openai',
      'openai.request.model': model,
      // Add host info for peer.service computation
      'out.host': 'api.openai.com'
    }
  }

  asyncEnd (ctx) {
    // Finish span in asyncEnd to complete the async operation
    // This allows LLMObs plugin's asyncEnd handler to set tags before finishing
    this.finish(ctx)
  }
}

class OpenAiChatCompletionsModelGetResponsePlugin extends BaseOpenaiAgentsClientPlugin {
  static prefix = 'tracing:@openai/agents:OpenAIChatCompletionsModel_getResponse'
  static spanName = 'openai-agents.getResponse'
}

class OpenAiChatCompletionsModelGetStreamedResponsePlugin extends BaseOpenaiAgentsClientPlugin {
  static prefix = 'tracing:@openai/agents:OpenAIChatCompletionsModel_getStreamedResponse'
  static spanName = 'openai-agents.getStreamedResponse'
}

class ToolInvokePlugin extends BaseOpenaiAgentsClientPlugin {
  static prefix = 'tracing:@openai/agents:tool_invoke'
  static spanName = 'openai-agents.invoke'
}

module.exports = {
  BaseOpenaiAgentsClientPlugin,
  OpenAiChatCompletionsModelGetResponsePlugin,
  OpenAiChatCompletionsModelGetStreamedResponsePlugin,
  ToolInvokePlugin
}
