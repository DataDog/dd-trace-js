'use strict'

const CompositePlugin = require('../../../../dd-trace/src/plugins/composite')
const BedrockAgentRuntimeLLMObsPlugin = require('../../../../dd-trace/src/llmobs/plugins/bedrockagentruntime')
const BedrockAgentRuntimeTracing = require('./tracing')

class BedrockAgentRuntimePlugin extends CompositePlugin {
  static id = 'bedrockagentruntime'

  static get plugins () {
    return {
      llmobs: BedrockAgentRuntimeLLMObsPlugin,
      tracing: BedrockAgentRuntimeTracing,
    }
  }
}

module.exports = BedrockAgentRuntimePlugin
