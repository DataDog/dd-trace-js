'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const { getIntegration } = require('./registry')

/**
 * Small plugin driving the Python supplement `tag_agent_manifest`. Subscribes
 * to the orchestrion channel for `AgentRunner._runSingleTurn` (and the streamed
 * variant) and tags the active agent's dd-trace span with the agent manifest.
 *
 * Unlike the old per-function plugins, this one does NOT start or finish a span
 * — the dd-trace agent span is created by the processor when agents-core emits
 * its `agent`-type Span. This plugin only enriches that existing span.
 */
class AgentRunnerTurnPlugin extends TracingPlugin {
  static id = 'openai-agents-run-single-turn'
  static prefix = 'tracing:orchestrion:@openai/agents-core:runSingleTurn'

  bindStart (ctx) {
    // Resolve the agents-core current span as of turn start; we'll tag its
    // dd-trace counterpart on asyncEnd. agents-core puts the agent-type Span
    // on the execution context via withAgentSpan before calling _runSingleTurn,
    // so getCurrentSpan() from outside the library isn't available to us —
    // instead, resolve lazily in asyncEnd via the integration's span map using
    // the parent chain of whatever response/function span lands inside the turn.
    return ctx.currentStore
  }

  asyncEnd (ctx) {
    const integration = getIntegration()
    if (!integration?.enabled) return

    const agent = ctx.arguments?.[0]
    if (!agent) return

    // The dd-trace span to tag is the most recently started `agent`-type span.
    // agents-core's Span.parent chain guarantees it is still open when
    // _runSingleTurn returns (withAgentSpan brackets the turn).
    const ddSpan = integration.currentAgentSpan?.()
    if (!ddSpan) return

    integration.tagAgentManifest(ddSpan, agent)
  }
}

class AgentRunnerTurnStreamedPlugin extends AgentRunnerTurnPlugin {
  static id = 'openai-agents-run-single-turn-streamed'
  static prefix = 'tracing:orchestrion:@openai/agents-core:runSingleTurnStreamed'
}

module.exports = [AgentRunnerTurnPlugin, AgentRunnerTurnStreamedPlugin]
