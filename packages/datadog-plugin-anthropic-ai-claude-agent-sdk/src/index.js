'use strict'

const { storage } = require('../../datadog-core')
const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const OutboundPlugin = require('../../dd-trace/src/plugins/outbound')
const { spanHasError } = require('../../dd-trace/src/llmobs/util')
const { IS_SERVERLESS } = require('../../dd-trace/src/serverless')

// The orchestrion `traceAsyncIterator` transform installs two channels:
//   - `:query`       fires once when `tj$` is called (span starts here).
//   - `:query_next`  fires per `next()` call on the returned Query (span
//                    finishes when iteration completes or errors).
// See `.agents/skills/apm-integrations/references/async-iterator-pattern.md`.

function finishWithPeerService (plugin, span) {
  plugin.tagPeerService(span)
  if (IS_SERVERLESS) {
    const peerHostname = storage('peerServerless').getStore()?.peerHostname
    if (peerHostname) span.setTag('peer.service', peerHostname)
  }
  span.finish()
}

class QueryPlugin extends OutboundPlugin {
  static id = 'anthropic-ai-claude-agent-sdk_query'
  static component = 'anthropic-ai-claude-agent-sdk'
  static prefix = 'tracing:orchestrion:@anthropic-ai/claude-agent-sdk:query'

  bindStart (ctx) {
    this.startSpan('anthropic-ai-claude-agent-sdk.query', {
      service: this.config.service,
      kind: 'client',
      meta: {
        'out.host': 'api.anthropic.com',
      },
    }, ctx)

    return ctx.currentStore
  }

  error (ctx) {
    const span = ctx?.currentStore?.span
    if (!span) return
    this.addError(ctx?.error, span)
    // tj$ threw sync (or its returned Promise rejected) — iteration never
    // starts, so `:query_next:asyncEnd` cannot finish the span. Do it here.
    finishWithPeerService(this, span)
  }
}

class QueryNextPlugin extends OutboundPlugin {
  static id = 'anthropic-ai-claude-agent-sdk_query_next'
  static component = 'anthropic-ai-claude-agent-sdk'
  static prefix = 'tracing:orchestrion:@anthropic-ai/claude-agent-sdk:query_next'

  bindStart (ctx) {
    return ctx.currentStore
  }

  asyncEnd (ctx) {
    const span = ctx?.currentStore?.span
    if (!span) return
    if (ctx.result?.done === true || spanHasError(span)) {
      finishWithPeerService(this, span)
    }
  }
}

class AnthropicAiClaudeAgentSdkPlugin extends CompositePlugin {
  static id = 'anthropic-ai-claude-agent-sdk'
  static plugins = {
    query: QueryPlugin,
    query_next: QueryNextPlugin,
  }
}

module.exports = AnthropicAiClaudeAgentSdkPlugin
