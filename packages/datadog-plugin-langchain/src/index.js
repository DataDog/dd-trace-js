'use strict'

const LangChainTracingPlugin = require('./tracing')
const LangChainLLMObsPlugin = require('../../dd-trace/src/llmobs/plugins/langchain')
const CompositePlugin = require('../../dd-trace/src/plugins/composite')

class LangChainPlugin extends CompositePlugin {
  static get id () { return 'langchain' }
  static get plugins () {
    return {
      // ordering here is important - the llm observability plugin must come first
      // so that we can add annotations associated with the span before it finishes.
      // however, because the tracing plugin uses `bindStart` vs the llmobs' `start`,
      // the span is guaranteed to be created in the tracing plugin before the llmobs one is called
      llmobs: LangChainLLMObsPlugin,
      tracing: LangChainTracingPlugin
    }
  }
}

module.exports = LangChainPlugin
