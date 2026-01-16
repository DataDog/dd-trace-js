'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const {
  LangchainLanggraphInvokeLLMObsPlugin,
  LangchainLanggraphStreamLLMObsPlugin
} = require('../../dd-trace/src/llmobs/plugins/langgraph')
const { LanggraphInvokePlugin, LanggraphStreamPlugin } = require('./tracing')

// LLMObs plugins must come first so we can add annotations before span finishes
// However, because tracing plugin uses `bindStart` vs llmobs' `start`,
// the span is guaranteed to be created in tracing plugin before llmobs is called
const plugins = {
  [LangchainLanggraphInvokeLLMObsPlugin.id]: LangchainLanggraphInvokeLLMObsPlugin,
  [LangchainLanggraphStreamLLMObsPlugin.id]: LangchainLanggraphStreamLLMObsPlugin,
  [LanggraphInvokePlugin.id]: LanggraphInvokePlugin,
  [LanggraphStreamPlugin.id]: LanggraphStreamPlugin
}

class LanggraphPlugin extends CompositePlugin {
  static id = 'langgraph'
  static plugins = plugins
}

module.exports = LanggraphPlugin
