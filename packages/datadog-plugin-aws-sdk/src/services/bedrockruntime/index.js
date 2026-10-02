'use strict'

const CompositePlugin = require('../../../../dd-trace/src/plugins/composite')
const BedrockRuntimeLLMObsPlugin = require('../../../../dd-trace/src/llmobs/plugins/bedrockruntime')
const SonicLLMObsPlugin = require('../../../../dd-trace/src/llmobs/plugins/nova-sonic')
const BedrockRuntimeTracing = require('./tracing')
const SonicTracingPlugin = require('./sonic')
class BedrockRuntimePlugin extends CompositePlugin {
  static id = 'bedrockruntime'

  static get plugins () {
    return {
      llmobs: BedrockRuntimeLLMObsPlugin,
      sonicLlmobs: SonicLLMObsPlugin,
      tracing: BedrockRuntimeTracing,
      sonicTracing: SonicTracingPlugin,
    }
  }
}
module.exports = BedrockRuntimePlugin
