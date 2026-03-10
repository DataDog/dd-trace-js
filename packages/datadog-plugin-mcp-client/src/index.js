'use strict'

const mcpClientLLMObsPlugins = require('../../dd-trace/src/llmobs/plugins/mcp-client')
const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const clientPlugin = require('./client')

const plugins = {}

// ordering here is important - the llm observability plugin must come first
// so that we can add annotations associated with the span before it finishes.
// however, because the tracing plugin uses `bindStart` vs the llmobs' `start`,
// the span is guaranteed to be created in the tracing plugin before the llmobs one is called
for (const Plugin of mcpClientLLMObsPlugins) {
  plugins[Plugin.id] = Plugin
}

Object.assign(plugins, clientPlugin)

class McpClientPlugin extends CompositePlugin {
  static id = 'mcp-client'
  static plugins = plugins
}

module.exports = McpClientPlugin
