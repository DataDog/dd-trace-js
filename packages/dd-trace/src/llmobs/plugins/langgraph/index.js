'use strict'

const LLMObsPlugin = require('../base')
const { spanHasError } = require('../../util')

class BaseLangGraphLLMObsPlugin extends LLMObsPlugin {
  static integration = 'langgraph'
  static id = 'langgraph'

  getLLMObsSpanRegisterOptions (ctx) {
    const span = ctx.currentStore?.span
    const name = span?.context()._tags?.['resource.name'] || 'langgraph.workflow'

    return {
      kind: 'workflow',
      name,
    }
  }

  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    const inputs = ctx.arguments?.[0]
    const results = ctx.result
    const hasError = ctx.error || spanHasError(span)

    const input = inputs !== undefined && inputs !== null ? this.formatIO(inputs) : undefined
    const output = hasError
      ? undefined
      : (results !== undefined && results !== null ? this.formatIO(results) : undefined)

    this._tagger.tagTextIO(span, input, output)
  }

  formatIO (data) {
    // Handle null/undefined explicitly
    if (data === null || data === undefined) return ''

    // Preserve primitive types (numbers, booleans) as-is
    if (typeof data === 'string' || typeof data === 'number' || typeof data === 'boolean') {
      return data
    }

    if (data.constructor?.name === 'Object') {
      const formatted = {}
      for (const [key, value] of Object.entries(data)) {
        formatted[key] = this.formatIO(value)
      }
      return formatted
    }

    if (Array.isArray(data)) {
      return data.map(item => this.formatIO(item))
    }

    // For other types (Date, etc.), stringify
    try {
      return JSON.stringify(data)
    } catch {
      return String(data)
    }
  }
}

class PregelInvokeLLMObsPlugin extends BaseLangGraphLLMObsPlugin {
  static id = 'llmobs_langgraph_pregel_invoke'
  static prefix = 'tracing:orchestrion:@langchain/langgraph:Pregel_invoke'
}

class PregelStreamLLMObsPlugin extends BaseLangGraphLLMObsPlugin {
  static id = 'llmobs_langgraph_pregel_stream'
  static prefix = 'tracing:orchestrion:@langchain/langgraph:Pregel_stream'
}

module.exports = [
  PregelInvokeLLMObsPlugin,
  PregelStreamLLMObsPlugin,
]
