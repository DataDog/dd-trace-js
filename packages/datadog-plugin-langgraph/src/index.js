'use strict'

const langgraphLLMObsPlugins = require('../../dd-trace/src/llmobs/plugins/langgraph')
const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const internalPlugin = require('./internal')

const plugins = {}

// ordering here is important - the llm observability plugin must come first
// so that we can add annotations associated with the span before it finishes.
// however, because the tracing plugin uses `bindStart` vs the llmobs' `start`,
// the span is guaranteed to be created in the tracing plugin before the llmobs one is called
for (const Plugin of langgraphLLMObsPlugins) {
  plugins[Plugin.id] = Plugin
}

for (const [id, Plugin] of Object.entries(internalPlugin)) {
  plugins[id] = Plugin
}

class LanggraphPlugin extends CompositePlugin {
  static id = 'langgraph'
  static plugins = plugins
}

module.exports = LanggraphPlugin
