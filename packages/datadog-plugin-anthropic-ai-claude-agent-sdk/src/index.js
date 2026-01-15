'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const clientPlugin = require('./client')

class AnthropicAiClaudeAgentSdkPlugin extends CompositePlugin {
  static id = 'anthropic-ai-claude-agent-sdk'
  static plugins = {
    ...clientPlugin
  }
}

module.exports = AnthropicAiClaudeAgentSdkPlugin
