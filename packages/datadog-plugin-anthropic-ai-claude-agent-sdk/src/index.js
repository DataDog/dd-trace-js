'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

/**
 * dd-trace plugin for @anthropic-ai/claude-agent-sdk.
 *
 * Instruments the query() function which spawns a Claude Code subprocess
 * and returns an AsyncGenerator<SDKMessage> covering the full agent lifecycle.
 * The span starts on call and ends when the generator is exhausted or throws.
 */
class ClaudeAgentSdkPlugin extends TracingPlugin {
  static get id () { return 'claude-agent-sdk' }
  static get operation () { return 'query' }
  static get system () { return 'anthropic' }

  bindStart (ctx) {
    const { params } = ctx

    this.startSpan('claude_agent_sdk.query', {
      service: this.config.service,
      meta: {
        'ai.operation.name': 'claude_agent_sdk.query',
        'component': '@anthropic-ai/claude-agent-sdk',
        'span.kind': 'client',
        ...params?.options?.model ? { 'ai.model.name': params.options.model } : {},
        ...typeof params?.prompt === 'string' ? { 'ai.prompt': params.prompt.slice(0, 1024) } : {}
      }
    }, ctx)

    return ctx.currentStore
  }

  asyncEnd (ctx) {
    const span = ctx.currentStore?.span
    span?.finish()
  }
}

module.exports = ClaudeAgentSdkPlugin
