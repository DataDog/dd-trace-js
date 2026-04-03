'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const AnthropicLLMObsPlugin = require('../../dd-trace/src/llmobs/plugins/anthropic')
const AnthropicTracingPlugin = require('./tracing')

class AnthropicPlugin extends CompositePlugin {
  static id = 'anthropic'
  static get plugins () {
    return {
      llmobs: AnthropicLLMObsPlugin,
      tracing: AnthropicTracingPlugin,
    }
  }
}

module.exports = AnthropicPlugin
