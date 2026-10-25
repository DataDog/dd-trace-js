'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const MistralAILLMObsPlugin = require('../../dd-trace/src/llmobs/plugins/mistralai')
const MistralAITracingPlugin = require('./tracing')

class MistralAIPlugin extends CompositePlugin {
  static id = 'mistralai'
  static get plugins () {
    return {
      llmobs: MistralAILLMObsPlugin,
      tracing: MistralAITracingPlugin,
    }
  }
}

module.exports = MistralAIPlugin
