'use strict'

const CompositePlugin = require('../../../../dd-trace/src/plugins/composite')
const BedrockRuntimeTracing = require('./tracing')
const BedrockRuntimeLLMObsPlugin = require('../../../../dd-trace/src/llmobs/plugins/bedrockruntime')
class BedrockRuntimePlugin extends CompositePlugin {
  static id = 'bedrockruntime'

  static get plugins () {
    return {
      llmobs: BedrockRuntimeLLMObsPlugin,
      tracing: BedrockRuntimeTracing
    }
  }
}
module.exports = BedrockRuntimePlugin
