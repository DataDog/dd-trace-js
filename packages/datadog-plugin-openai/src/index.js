'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const OpenAiTracingPlugin = require('./tracing')
const OpenAiTracingPluginOrchestrion = require('./orchestrion-migration')
const OpenAiLLMObsPlugin = require('../../dd-trace/src/llmobs/plugins/openai')

class OpenAiPlugin extends CompositePlugin {
  static get id () { return 'openai' }
  static get plugins () {
    return {
      llmobs: OpenAiLLMObsPlugin,
      tracing: OpenAiTracingPlugin, // this one will go away
      // the below plugin should replace the above tracing plugin and be renamed to "tracing"
      orchestrion: OpenAiTracingPluginOrchestrion
    }
  }
}

module.exports = OpenAiPlugin
