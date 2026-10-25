'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const llamaIndexLLMObsPlugins = require('../../dd-trace/src/llmobs/plugins/llamaindex')
const llamaIndexTracingPlugins = require('./tracing')

const plugins = {}

for (const Plugin of llamaIndexLLMObsPlugins) {
  plugins[Plugin.id] = Plugin
}

for (const Plugin of llamaIndexTracingPlugins) {
  plugins[Plugin.id] = Plugin
}

class LlamaIndexPlugin extends CompositePlugin {
  static id = 'llamaindex'
  static plugins = plugins
}

module.exports = LlamaIndexPlugin
