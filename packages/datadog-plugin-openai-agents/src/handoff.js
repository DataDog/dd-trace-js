'use strict'

const { MEASURED } = require('../../../ext/tags')
const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

class OpenAiAgentsHandoffPlugin extends TracingPlugin {
  static id = 'openai-agents'
  static operation = 'handoff'
  static prefix = 'tracing:apm:openai-agents:handoff'
  static system = 'openai'

  bindStart (ctx) {
    const { agentName, toAgentName, handoffToolName } = ctx

    const resource = toAgentName
      ? `${agentName || 'agent'} -> ${toAgentName}`
      : 'handoff'

    const span = this.startSpan('openai.agents.handoff', {
      service: this.config.service,
      resource,
      type: 'openai',
      kind: 'client',
      meta: {
        [MEASURED]: 1,
        component: 'openai-agents',
        'openai.agents.from_agent': agentName,
        'openai.agents.to_agent': toAgentName,
        'openai.agents.handoff_tool': handoffToolName
      }
    }, ctx)

    // Inject trace context into handoff data for cross-process propagation
    ctx._datadog = {}
    this.tracer.inject(span, 'text_map', ctx._datadog)

    return ctx.currentStore
  }

  asyncEnd (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    // Extract result to capture the target agent
    const result = ctx.result
    if (result?.nextStep?.type === 'next_step_handoff') {
      const newAgent = result.nextStep.newAgent
      if (newAgent?.name) {
        span.setTag('openai.agents.to_agent', newAgent.name)
      }
    }

    span.finish()
  }
}

module.exports = OpenAiAgentsHandoffPlugin
