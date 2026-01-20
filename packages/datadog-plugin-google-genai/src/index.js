'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const GenAiLLMObsPlugin = require('../../dd-trace/src/llmobs/plugins/genai')
const GenAiTracingPlugin = require('./tracing')

class GenAiPlugin extends CompositePlugin {
  static id = 'google-genai'
  static get plugins () {
    return {
      llmobs: GenAiLLMObsPlugin,
      tracing: GenAiTracingPlugin
    }
  }
}

module.exports = GenAiPlugin
