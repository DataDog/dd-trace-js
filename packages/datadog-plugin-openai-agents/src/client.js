'use strict'

const ClientPlugin = require('../../dd-trace/src/plugins/client')

class OpenAIAgentsGetResponsePlugin extends ClientPlugin {
  static id = 'openai-agents'
  static prefix = 'tracing:apm:openai-agents:getResponse'
  static peerServicePrecursors = ['ai.request.model_provider']

  bindStart (ctx) {
    const meta = this.getTags(ctx)

    this.startSpan('openai-agents.getResponse', {
      service: this.config.service,
      meta
    }, ctx)

    return ctx.currentStore
  }

  getTags (ctx) {
    return {
      component: 'openai-agents',
      'span.kind': 'client',
      'ai.request.model_provider': 'openai'
    }
  }

  asyncEnd (ctx) {
    this.finish(ctx)
  }

  error (ctx) {
    super.error(ctx)
    this.finish(ctx)
  }

  finish (ctx) {
    if (!ctx.hasOwnProperty('result') && !ctx.hasOwnProperty('error')) return

    const span = ctx.currentStore?.span
    if (span && ctx.result) {
      const { providerData, usage } = ctx.result
      if (providerData) {
        span.setTag('ai.request.model', providerData.model)
        span.setTag('openai.request.model', providerData.model)
        span.setTag('openai.response.model', providerData.model)
        span.setTag('openai.response.id', providerData.id)
        span.setTag('openai.response.created', providerData.created)
      }
      if (usage) {
        span.setTag('openai.response.usage.prompt_tokens', usage.inputTokens)
        span.setTag('openai.response.usage.completion_tokens', usage.outputTokens)
        span.setTag('openai.response.usage.total_tokens', usage.totalTokens)
      }
    }

    super.finish(ctx)
  }
}

class OpenAIAgentsGetStreamedResponsePlugin extends ClientPlugin {
  static id = 'openai-agents'
  static prefix = 'tracing:apm:openai-agents:getStreamedResponse'
  static peerServicePrecursors = ['ai.request.model_provider']

  bindStart (ctx) {
    const meta = this.getTags(ctx)

    this.startSpan('openai-agents.getStreamedResponse', {
      service: this.config.service,
      meta
    }, ctx)

    return ctx.currentStore
  }

  getTags (ctx) {
    return {
      component: 'openai-agents',
      'span.kind': 'client',
      'ai.request.model_provider': 'openai'
    }
  }

  asyncEnd (ctx) {
    this.finish(ctx)
  }

  error (ctx) {
    super.error(ctx)
    this.finish(ctx)
  }

  finish (ctx) {
    if (!ctx.hasOwnProperty('result') && !ctx.hasOwnProperty('error')) return

    const span = ctx.currentStore?.span
    if (span && ctx.result) {
      const { providerData, usage } = ctx.result
      if (providerData) {
        span.setTag('ai.request.model', providerData.model)
        span.setTag('openai.request.model', providerData.model)
        span.setTag('openai.response.model', providerData.model)
        span.setTag('openai.response.id', providerData.id)
        span.setTag('openai.response.created', providerData.created)
      }
      if (usage) {
        span.setTag('openai.response.usage.prompt_tokens', usage.inputTokens)
        span.setTag('openai.response.usage.completion_tokens', usage.outputTokens)
        span.setTag('openai.response.usage.total_tokens', usage.totalTokens)
      }
    }

    super.finish(ctx)
  }
}

module.exports = [
  OpenAIAgentsGetResponsePlugin,
  OpenAIAgentsGetStreamedResponsePlugin
]
