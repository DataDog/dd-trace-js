'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const OpenAiTracingPlugin = require('./tracing')
const OpenAiLLMObsPlugin = require('../../dd-trace/src/llmobs/plugins/openai')

class OpenAiPlugin extends CompositePlugin {
  static get id () { return 'openai' }
  static get plugins () {
    return {
      llmobs: OpenAiLLMObsPlugin,
      tracing: OpenAiTracingPlugin
    }
  }
}

module.exports = OpenAiPlugin
