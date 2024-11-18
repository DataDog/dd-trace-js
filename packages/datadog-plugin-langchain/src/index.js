'use strict'

const LangChainTracingPlugin = require('./tracing')
const LangChainLLMObsPlugin = require('../../dd-trace/src/llmobs/plugins/langchain')
const CompositePlugin = require('../../dd-trace/src/plugins/composite')

class LangChainPlugin extends CompositePlugin {
  static get id () { return 'langchain' }
  static get plugins () {
    return {
      llmobs: LangChainLLMObsPlugin,
      tracing: LangChainTracingPlugin
    }
  }
}

module.exports = LangChainPlugin
