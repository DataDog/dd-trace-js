'use strict'

const { MEASURED } = require('../../../ext/tags')
const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

class OpenAiAgentsToolPlugin extends TracingPlugin {
  static id = 'openai-agents'
  static operation = 'tool'
  static prefix = 'tracing:apm:openai-agents:tool'
  static system = 'openai'

  bindStart (ctx) {
    const { agentName, toolNames } = ctx

    const resource = toolNames?.length
      ? toolNames.join(', ')
      : 'tool_execution'

    const span = this.startSpan('openai.agents.tool', {
      service: this.config.service,
      resource,
      type: 'openai',
      kind: 'client',
      meta: {
        [MEASURED]: 1,
        component: 'openai-agents',
        'openai.agents.agent_name': agentName
      }
    }, ctx)

    if (toolNames?.length) {
      span.setTag('openai.agents.tool_names', toolNames.join(', '))
      span.setTag('openai.agents.tool_count', toolNames.length)
    }

    return ctx.currentStore
  }

  asyncEnd (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    span.finish()
  }
}

module.exports = OpenAiAgentsToolPlugin
