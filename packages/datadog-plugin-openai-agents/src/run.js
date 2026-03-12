'use strict'

const { MEASURED } = require('../../../ext/tags')
const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

class OpenAiAgentsRunPlugin extends TracingPlugin {
  static id = 'openai-agents'
  static operation = 'run'
  static prefix = 'tracing:apm:openai-agents:run'
  static system = 'openai'

  bindStart (ctx) {
    const { agentName, model, workflowName } = ctx

    const resource = agentName || 'agent'

    const span = this.startSpan('openai.agents.run', {
      service: this.config.service,
      resource,
      type: 'openai',
      kind: 'client',
      meta: {
        [MEASURED]: 1,
        component: 'openai-agents',
        'openai.agents.agent_name': agentName,
        'openai.agents.workflow_name': workflowName
      }
    }, ctx)

    if (model) {
      span.setTag('openai.agents.model', typeof model === 'string' ? model : model?.name)
    }

    return ctx.currentStore
  }

  asyncEnd (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    const result = ctx.result
    if (result) {
      const finalOutput = result._state?._currentStep
      if (finalOutput?.type === 'next_step_final_output') {
        span.setTag('openai.agents.output_type', 'final_output')
      }

      const usage = result._state?._context?.usage
      if (usage) {
        if (usage.inputTokens != null) {
          span.setTag('openai.agents.usage.input_tokens', usage.inputTokens)
        }
        if (usage.outputTokens != null) {
          span.setTag('openai.agents.usage.output_tokens', usage.outputTokens)
        }
        if (usage.totalTokens != null) {
          span.setTag('openai.agents.usage.total_tokens', usage.totalTokens)
        }
      }
    }

    span.finish()
  }
}

module.exports = OpenAiAgentsRunPlugin
