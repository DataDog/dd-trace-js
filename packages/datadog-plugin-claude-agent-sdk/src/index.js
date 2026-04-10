'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const ClaudeAgentSdkLLMObsPlugins = require('../../dd-trace/src/llmobs/plugins/claude-agent-sdk')
const ClaudeAgentSdkTracingPlugins = require('./tracing')

class ClaudeAgentSdkPlugin extends CompositePlugin {
  static id = 'claude-agent-sdk'

  static get plugins () {
    const plugins = {}

    // LLM Obs plugins must be registered before tracing plugins so that
    // annotations are added to the span before it finishes.
    // The tracing plugin uses `bindStart` vs the LLM Obs plugin's `start`,
    // so the span is created in the tracing plugin before the LLM Obs one runs.
    for (const Plugin of ClaudeAgentSdkLLMObsPlugins) {
      plugins[Plugin.id] = Plugin
    }

    for (const Plugin of ClaudeAgentSdkTracingPlugins) {
      plugins[Plugin.id] = Plugin
    }

    return plugins
  }
}

module.exports = ClaudeAgentSdkPlugin
