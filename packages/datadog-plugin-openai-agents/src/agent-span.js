'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const { storage } = require('../../datadog-core')
const LLMObsTagger = require('../../dd-trace/src/llmobs/tagger')

const COMPONENT = 'openai-agents'

/**
 * Shared module-level map of agents-core spanId → dd-trace span. Both the
 * APM AgentSpanStartPlugin and AgentSpanEndPlugin read/write it so the end
 * hook can find the start-side dd-trace span, and so parentId resolution
 * works for nested agent spans in handoff scenarios.
 *
 * Also stores the previous async-context store alongside the dd-trace span
 * so we can restore it in the end hook, making the agent span the active
 * parent for LLM/tool/handoff spans created during its lifetime.
 *
 * @type {Map<string, { ddSpan: import('../../dd-trace/src/opentracing/span'), prevStore: object }>}
 */
const agentSpanMap = new Map()

/**
 * Starts a dd-trace agent span whenever agents-core emits an agent-type Span
 * via `MultiTracingProcessor.onSpanStart`. The span is parented via the
 * agents-core parentId chain (falling back to the current dd-trace active
 * span) so multi-agent handoff produces a correct per-agent nesting.
 *
 * The dd-trace span is activated in the legacy async-context storage so
 * existing orchestrion hooks (`openai-agents.getResponse`,
 * `openai-agents.invokeFunctionTool`, etc.) naturally parent to it for the
 * duration of the agent's execution.
 */
class AgentSpanStartPlugin extends TracingPlugin {
  static id = 'openai-agents-agent-span-start'
  static prefix = 'tracing:orchestrion:@openai/agents-core:multiProcessorSpanStart'

  constructor (...args) {
    super(...args)
    this._tagger = new LLMObsTagger(this._tracerConfig, true)
  }

  bindStart (ctx) {
    // Arg 0 is the agents-core Span. Only act on agent-type spans; leave
    // every other span type (response, handoff, function, guardrail) to the
    // existing function-level orchestrion plugins.
    const oaiSpan = ctx.arguments?.[0]
    if (!oaiSpan?.spanData || oaiSpan.spanData.type !== 'agent') return ctx.currentStore

    const agentName = oaiSpan.spanData.name
    const spanName = agentName
      ? `openai-agents.agent.${agentName}`
      : 'openai-agents.agent'

    const { childOf, parent } = this._resolveParent(oaiSpan, ctx.currentStore)

    const ddSpan = this.tracer.startSpan(spanName, {
      childOf,
      tags: {
        component: COMPONENT,
        'span.kind': 'internal',
      },
    })

    this._tagger.registerLLMObsSpan(ddSpan, {
      kind: 'agent',
      name: agentName || 'openai-agents.agent',
      integration: COMPONENT,
      parent,
    })

    const prevStore = storage('legacy').getStore()
    storage('legacy').enterWith({ ...prevStore, span: ddSpan })

    agentSpanMap.set(oaiSpan.spanId, { ddSpan, prevStore })

    return { ...ctx.currentStore, span: ddSpan }
  }

  _resolveParent (oaiSpan, currentStore) {
    const entry = oaiSpan.parentId ? agentSpanMap.get(oaiSpan.parentId) : undefined
    if (entry) return { childOf: entry.ddSpan, parent: entry.ddSpan }
    // Fall back to the currently-active dd-trace span. Check the orchestrion
    // ctx store first, then dd-trace's global scope (the run() orchestrion
    // hook stores its workflow span in a different channel's bindStore scope
    // so it's not always on ctx.currentStore here).
    const active = currentStore?.span || this.tracer.scope().active()
    return { childOf: active, parent: active }
  }
}

/**
 * Finishes the dd-trace agent span and restores the previous async-context
 * store, preserving the ordering (agent span ends before run's asyncEnd so
 * the workflow span remains active for any tail work).
 */
class AgentSpanEndPlugin extends TracingPlugin {
  static id = 'openai-agents-agent-span-end'
  static prefix = 'tracing:orchestrion:@openai/agents-core:multiProcessorSpanEnd'

  constructor (...args) {
    super(...args)
    this._tagger = new LLMObsTagger(this._tracerConfig, true)
  }

  bindStart (ctx) {
    return ctx.currentStore
  }

  asyncEnd (ctx) {
    const oaiSpan = ctx.arguments?.[0]
    if (!oaiSpan?.spanData || oaiSpan.spanData.type !== 'agent') return

    const entry = agentSpanMap.get(oaiSpan.spanId)
    if (!entry) return
    agentSpanMap.delete(oaiSpan.spanId)

    const { ddSpan, prevStore } = entry

    // Mirror Python's _llmobs_set_agent_attributes: tag metadata captured on
    // the SDK's own spanData (handoffs, tools, output_type). Input/output stay
    // with the existing workflow/LLM plugins — no new tag keys introduced.
    const metadata = {}
    const spanData = oaiSpan.spanData
    if (Array.isArray(spanData?.handoffs) && spanData.handoffs.length > 0) {
      metadata.handoffs = spanData.handoffs
    }
    if (Array.isArray(spanData?.tools) && spanData.tools.length > 0) {
      metadata.tools = spanData.tools
    }
    if (spanData?.output_type) metadata.output_type = spanData.output_type
    if (Object.keys(metadata).length > 0) this._tagger.tagMetadata(ddSpan, metadata)

    if (oaiSpan.error) {
      ddSpan.setTag('error', true)
      if (oaiSpan.error.message) ddSpan.setTag('error.type', oaiSpan.error.message)
      if (oaiSpan.error.data) {
        try {
          ddSpan.setTag('error.message', JSON.stringify(oaiSpan.error.data))
        } catch {
          // non-serializable, skip
        }
      }
    }

    ddSpan.finish()

    // Restore the async-context store that was active before this agent span
    // started, so the parent (workflow or outer agent) resumes as current.
    if (prevStore !== undefined) storage('legacy').enterWith(prevStore)
  }
}

module.exports = [AgentSpanStartPlugin, AgentSpanEndPlugin]
module.exports.agentSpanMap = agentSpanMap
