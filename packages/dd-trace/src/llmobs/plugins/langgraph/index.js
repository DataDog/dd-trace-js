'use strict'

const LLMObsPlugin = require('../base')

const WORKFLOW = 'workflow'

/**
 * Base LangGraph LLMObs plugin for observability
 */
class BaseLanggraphLLMObsPlugin extends LLMObsPlugin {
  static integration = 'langgraph'
  static id = 'langgraph'
  static prefix = 'tracing:orchestrion:@langchain/langgraph:Pregel_invoke'

  /**
   * Get LLMObs span registration options
   * @param {object} ctx - Context object
   * @returns {{ kind: string, name: string }}
   */
  getLLMObsSpanRegisterOptions (ctx) {
    const span = ctx.currentStore?.span
    const tags = span?.context()._tags || {}

    return {
      kind: WORKFLOW,
      name: tags['resource.name'] || 'langgraph.invoke'
    }
  }

  /**
   * Set LLMObs tags on the span
   * @param {object} ctx - Context object containing args and result
   */
  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    const inputs = ctx.arguments?.[0]
    const result = ctx.result

    // Tag input if available
    if (inputs !== undefined) {
      this._tagger.tagInputValue(span, inputs)
    }

    // Tag output if available
    if (result !== undefined) {
      this._tagger.tagOutputValue(span, result)
    }
  }
}

/**
 * LLMObs plugin for Pregel invoke operations
 */
class PregelInvokeLLMObsPlugin extends BaseLanggraphLLMObsPlugin {
  static id = 'llmobs_langgraph_invoke'
  static prefix = 'tracing:orchestrion:@langchain/langgraph:Pregel_invoke'

  getLLMObsSpanRegisterOptions (ctx) {
    return {
      kind: WORKFLOW,
      name: 'langgraph.invoke'
    }
  }
}

/**
 * LLMObs plugin for Pregel stream operations
 */
class PregelStreamLLMObsPlugin extends BaseLanggraphLLMObsPlugin {
  static id = 'llmobs_langgraph_stream'
  static prefix = 'tracing:orchestrion:@langchain/langgraph:Pregel_stream'

  getLLMObsSpanRegisterOptions (ctx) {
    return {
      kind: WORKFLOW,
      name: 'langgraph.stream'
    }
  }
}

module.exports = [
  PregelInvokeLLMObsPlugin,
  PregelStreamLLMObsPlugin
]
