'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const langgraphLLMObsPlugins = require('../../dd-trace/src/llmobs/plugins/langgraph')
const streamPlugin = require('./stream')

const plugins = {}

// CRITICAL: LLMObs plugins MUST come first
for (const Plugin of langgraphLLMObsPlugins) {
  plugins[Plugin.id] = Plugin
}

// Tracing plugins second
for (const Plugin of streamPlugin) {
  plugins[Plugin.id] = Plugin
}

class LanggraphPlugin extends CompositePlugin {
  static id = 'langgraph'
  static plugins = plugins
}

module.exports = LanggraphPlugin
