'use strict'

const ClientPlugin = require('../../dd-trace/src/plugins/client')

const CLIENT_SYMBOL = Symbol.for('datadog.openai.client')

class OpenaiAgentsClientPlugin extends ClientPlugin {
  static id = 'openai_agents_llm_chat'
  static prefix = 'tracing:orchestrion:@openai/agents-openai:OpenAIChatCompletionsModel_getResponse'

  bindStart (ctx) {
    const meta = {
      component: 'openai-agents',
      'span.kind': 'client'
    }

    const model = ctx.self
    const client = model?.[CLIENT_SYMBOL]
    const baseURL = client?.baseURL

    // Extract model name from the model instance
    if (model?.model) {
      meta['openai-agents.request.model'] = model.model
    }

    if (baseURL) {
      try {
        const url = new URL(baseURL)
        meta['out.host'] = url.hostname
      } catch {
        // Invalid URL, skip
      }
    }

    this.startSpan('openai-agents.getResponse', {
      service: this.config.service,
      kind: 'client',
      meta
    }, ctx)

    return ctx.currentStore
  }

  asyncEnd (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    if (ctx.result?.usage) {
      const usage = ctx.result.usage
      if (usage.inputTokens !== undefined) {
        span.setTag('openai-agents.response.usage.input_tokens', String(usage.inputTokens))
      }
      if (usage.outputTokens !== undefined) {
        span.setTag('openai-agents.response.usage.output_tokens', String(usage.outputTokens))
      }
      if (usage.totalTokens !== undefined) {
        span.setTag('openai-agents.response.usage.total_tokens', String(usage.totalTokens))
      }
    }

    super.finish(ctx)
  }
}

module.exports = OpenaiAgentsClientPlugin
