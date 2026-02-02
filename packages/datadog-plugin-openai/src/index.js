'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const OpenAiLLMObsPlugin = require('../../dd-trace/src/llmobs/plugins/openai')
const OpenAiTracingPlugin = require('./tracing')

class OpenAiPlugin extends CompositePlugin {
  static id = 'openai'
  static get plugins () {
    return {
      llmobs: OpenAiLLMObsPlugin,
      tracing: OpenAiTracingPlugin,
    }
  }
}

module.exports = OpenAiPlugin
