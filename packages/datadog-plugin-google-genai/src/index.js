'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const GenAiTracingPlugin = require('./tracing')
const GenAiLLMObsPlugin = require('../../dd-trace/src/llmobs/plugins/genai')

class GenAiPlugin extends CompositePlugin {
  static id = 'genai'
  static get plugins () {
    return {
      llmobs: GenAiLLMObsPlugin,
      tracing: GenAiTracingPlugin
    }
  }
}

module.exports = GenAiPlugin
