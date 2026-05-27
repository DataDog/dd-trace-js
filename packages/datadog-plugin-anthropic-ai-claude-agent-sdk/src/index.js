'use strict'

const { storage } = require('../../datadog-core')
const OutboundPlugin = require('../../dd-trace/src/plugins/outbound')
const { IS_SERVERLESS } = require('../../dd-trace/src/serverless')

// The orchestrion AST rewriter (see
// `datadog-instrumentations/src/helpers/rewriter/instrumentations/anthropic-ai-claude-agent-sdk.js`)
// wraps the bundled `tj$` function with `traceSync`. dc-polyfill's `traceSync`
// publishes `:start` (via `runStores`), `:error` only when the call throws,
// and always `:end` in the finally block — there are no asyncStart/asyncEnd
// events for this transform.
//
// We therefore start the span in `bindStart` and finish it in `end`. The
// inherited `error` handler from TracingPlugin tags the error on the span
// before `end` fires (order: start → error → end), so the error path lands
// the expected `error.{type,message,stack}` tags and `error: 1` on the same
// span the happy path produces.
//
// We extend OutboundPlugin (rather than TracingPlugin) so peer.service is
// computed automatically from the `out.host` precursor tag we set in
// `bindStart`. Because orchestrion's `traceSync` never publishes a `:finish`
// event, OutboundPlugin's `finish` handler is never wired up — so we
// re-implement its tagging behaviour ourselves in `end`, including the
// `IS_SERVERLESS` peer.service override, before finishing the span.
class AnthropicAiClaudeAgentSdkPlugin extends OutboundPlugin {
  static id = 'anthropic-ai-claude-agent-sdk'
  static prefix = 'tracing:orchestrion:@anthropic-ai/claude-agent-sdk:query'

  bindStart (ctx) {
    this.startSpan('anthropic-ai-claude-agent-sdk.query', {
      service: this.config.service,
      kind: 'client',
      meta: {
        // Anthropic's Claude Agent SDK ultimately routes calls through the
        // Claude/Anthropic API. Surface that as the peer for service-map
        // and dependency-tracking purposes.
        'out.host': 'api.anthropic.com',
      },
    }, ctx)

    return ctx.currentStore
  }

  end (ctx) {
    // Guard: only finish if we actually started a span in bindStart. Without
    // this guard a stray `:end` publish on a context we don't own would
    // crash.
    const span = ctx?.currentStore?.span
    if (!span) return
    this.tagPeerService(span)
    if (IS_SERVERLESS) {
      const peerHostname = storage('peerServerless').getStore()?.peerHostname
      if (peerHostname) span.setTag('peer.service', peerHostname)
    }
    span.finish()
  }
}

module.exports = AnthropicAiClaudeAgentSdkPlugin
