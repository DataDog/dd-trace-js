'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

const ERROR_SUBTYPES = new Set([
  'error_during_execution',
  'error_max_turns',
  'error_max_budget_usd',
])

class AnthropicClaudeAgentSdkPlugin extends TracingPlugin {
  static id = 'anthropic-ai-claude-agent-sdk'
  static operation = 'query'
  static system = 'anthropic'
  static prefix = 'tracing:apm:anthropic-ai-claude-agent-sdk:query'

  constructor (...args) {
    super(...args)

    // Per-message channel emitted by the instrumentation as the generator
    // streams SDKMessage values. We use this to capture the model from the
    // initial SDKSystemMessage when the caller did not provide one.
    this.addSub('apm:anthropic-ai-claude-agent-sdk:message', ({ ctx, message }) => {
      const span = ctx.currentStore?.span
      if (!span || !message) return

      if (message.type === 'system' && message.subtype === 'init' && message.model) {
        const tags = span.context()._tags
        if (!tags['anthropic.request.model']) {
          span.setTag('anthropic.request.model', message.model)
        }
      }
    })
  }

  bindStart (ctx) {
    const { resource, options } = ctx
    const model = options?.model

    const meta = {
      'resource.name': resource,
      component: '@anthropic-ai/claude-agent-sdk',
      'span.kind': 'client',
    }

    if (model) {
      meta['anthropic.request.model'] = model
    }

    this.startSpan('anthropic.agent.query', { meta }, ctx)

    return ctx.currentStore
  }

  asyncEnd (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    const result = ctx.result
    if (result && typeof result === 'object') {
      this.#tagResult(span, result)
    }

    span.finish()
  }

  error (ctx) {
    const span = ctx.currentStore?.span
    if (span) {
      span.setTag('error', ctx.error)
    }
  }

  #tagResult (span, result) {
    const tags = {}

    if (result.session_id) tags['anthropic.agent.session_id'] = result.session_id
    if (typeof result.num_turns === 'number') tags['anthropic.agent.num_turns'] = result.num_turns
    if (typeof result.duration_ms === 'number') tags['anthropic.agent.duration_ms'] = result.duration_ms
    if (typeof result.total_cost_usd === 'number') tags['anthropic.agent.total_cost_usd'] = result.total_cost_usd
    if (result.terminal_reason) tags['anthropic.agent.terminal_reason'] = result.terminal_reason
    if (result.stop_reason) tags['anthropic.response.stop_reason'] = result.stop_reason
    if (result.subtype) tags['anthropic.response.subtype'] = result.subtype

    const usage = result.usage
    if (usage && typeof usage === 'object') {
      if (typeof usage.input_tokens === 'number') {
        tags['anthropic.response.input_tokens'] = usage.input_tokens
      }
      if (typeof usage.output_tokens === 'number') {
        tags['anthropic.response.output_tokens'] = usage.output_tokens
      }
      if (typeof usage.cache_read_input_tokens === 'number') {
        tags['anthropic.response.cache_read_input_tokens'] = usage.cache_read_input_tokens
      }
      if (typeof usage.cache_creation_input_tokens === 'number') {
        tags['anthropic.response.cache_creation_input_tokens'] = usage.cache_creation_input_tokens
      }
    }

    span.addTags(tags)

    if (result.is_error === true || ERROR_SUBTYPES.has(result.subtype)) {
      span.setTag('error', 1)
    }
  }
}

module.exports = AnthropicClaudeAgentSdkPlugin
