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

  /** @param {import('../../../../../').plugins.aws_sdk | boolean} config */
  configure (config) {
    if (typeof config === 'boolean') config = { enabled: config }
    const bedrock = config.bedrockruntime
    if (config.enabled === false || bedrock === false || bedrock?.enabled === false ||
        this._tracerConfig.DD_TRACE_AWS_SDK_BEDROCKRUNTIME_ENABLED === false) {
      // Disable the whole service before any child can subscribe and enable conversation capture.
      return super.configure(false)
    }
    const normalized = { ...config, ...bedrock }
    if (config.llmobs === false) normalized.llmobs = false
    super.configure(normalized)
  }
}
module.exports = BedrockRuntimePlugin
