'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const mcpLLMObsPlugins = require('../../dd-trace/src/llmobs/plugins/modelcontextprotocol-sdk')
const clientPlugin = require('./client')

const plugins = {}

// CRITICAL: LLMObs plugins MUST come first
for (const Plugin of mcpLLMObsPlugins) {
  plugins[Plugin.id] = Plugin
}

// Tracing plugins second
for (const Plugin of clientPlugin) {
  plugins[Plugin.id] = Plugin
}

class ModelcontextprotocolSdkPlugin extends CompositePlugin {
  static id = 'modelcontextprotocol-sdk'
  static plugins = plugins
}

module.exports = ModelcontextprotocolSdkPlugin
