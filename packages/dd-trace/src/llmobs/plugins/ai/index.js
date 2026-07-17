'use strict'

const CompositePlugin = require('../../../plugins/composite')
const DdTelemetryPlugin = require('./ddTelemetry')
const VercelAiTelemetryPlugin = require('./vercelTelemetry')

class VercelAILLMObsPlugin extends CompositePlugin {
  static id = 'ai_llmobs'
  static integration = 'ai'
  static plugins = {
    dd: DdTelemetryPlugin,
    ai: VercelAiTelemetryPlugin,
  }
}

module.exports = VercelAILLMObsPlugin
