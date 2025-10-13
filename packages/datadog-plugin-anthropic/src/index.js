'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const AnthropicTracingPlugin = require('./tracing')
const AnthropicLLMObsPlugin = require('../../dd-trace/src/llmobs/plugins/anthropic')

class AnthropicPlugin extends CompositePlugin {
  static id = 'anthropic'
  static get plugins () {
    return {
      llmobs: AnthropicLLMObsPlugin,
      tracing: AnthropicTracingPlugin
    }
  }
}

module.exports = AnthropicPlugin
