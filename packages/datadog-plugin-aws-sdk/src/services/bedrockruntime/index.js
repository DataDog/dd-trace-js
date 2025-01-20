const CompositePlugin = require('../../../../dd-trace/src/plugins/composite')
const BedrockRuntimeTracing = require('./tracing')
class BedrockRuntimePlugin extends CompositePlugin {
  static get id () {
    return 'bedrock'
  }

  static get plugins () {
    return {
      tracing: BedrockRuntimeTracing
    }
  }
}
module.exports = BedrockRuntimePlugin
