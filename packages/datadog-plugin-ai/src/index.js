'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const VercelAILLMObsPlugin = require('../../dd-trace/src/llmobs/plugins/ai')
const VercelAITracingPlugin = require('./tracing')

class VercelAIPlugin extends CompositePlugin {
  static get id () { return 'ai' }
  static get plugins () {
    return {
      llmobs: VercelAILLMObsPlugin,
      tracing: VercelAITracingPlugin
    }
  }
}

module.exports = VercelAIPlugin
