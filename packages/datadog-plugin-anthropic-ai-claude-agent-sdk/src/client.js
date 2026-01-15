'use strict'

const ClientPlugin = require('../../dd-trace/src/plugins/client')

class BaseAnthropicAiClaudeAgentSdkClientPlugin extends ClientPlugin {
  static id = 'anthropic-ai-claude-agent-sdk'
  static prefix = 'tracing:orchestrion:@anthropic-ai/claude-agent-sdk:query'
  static peerServicePrecursors = ['ai.request.model_provider']

  bindStart (ctx) {
    const meta = this.getTags(ctx)

    this.startSpan('request', {
      service: this.serviceName({ pluginService: this.config.service }),
      meta
    }, ctx)

    return ctx.currentStore
  }

  getTags (ctx) {
    return {
      component: 'anthropic-ai-claude-agent-sdk',
      'span.kind': 'client',
      'ai.request.model': ctx.self?.defaultOptions?.model,
      'ai.request.model_provider': 'anthropic',
      'anthropic.request.model': ctx.self?.defaultOptions?.model
    }
  }

  // asyncEnd and end delegate to finish() which has the required guard
  asyncEnd (ctx) {
    this.finish(ctx)
  }

  end (ctx) {
    this.finish(ctx)
  }

  // You may modify this method, but the guard below is REQUIRED and MUST NOT be removed!
  finish (ctx) {
    // CRITICAL GUARD - DO NOT REMOVE: Ensures span only finishes when operation completes
    if (!ctx.hasOwnProperty('result') && !ctx.hasOwnProperty('error')) return

    super.finish(ctx)
  }
}

class UnstableV2PromptPlugin extends BaseAnthropicAiClaudeAgentSdkClientPlugin {
  static prefix = 'tracing:orchestrion:@anthropic-ai/claude-agent-sdk:unstable_v2_prompt'
}

class SdkSessionSendPlugin extends BaseAnthropicAiClaudeAgentSdkClientPlugin {
  static prefix = 'tracing:orchestrion:@anthropic-ai/claude-agent-sdk:SDKSession_send'
}

module.exports = {
  BaseAnthropicAiClaudeAgentSdkClientPlugin,
  UnstableV2PromptPlugin,
  SdkSessionSendPlugin
}
