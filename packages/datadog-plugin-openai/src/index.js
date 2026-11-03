'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const OpenAiLLMObsPlugin = require('../../dd-trace/src/llmobs/plugins/openai')
const OpenAiRealtimeLLMObsPlugins = require('../../dd-trace/src/llmobs/plugins/openai/realtime')
const OpenAiRealtimeTracingPlugins = require('./realtime')
const OpenAiTracingPlugin = require('./tracing')

class OpenAiPlugin extends CompositePlugin {
  static id = 'openai'
  static get plugins () {
    const plugins = {
      llmobs: OpenAiLLMObsPlugin,
      tracing: OpenAiTracingPlugin,
    }

    // LLM Obs plugins must be registered before their tracing counterparts so that annotations are
    // added to the span before it finishes: subscribers run in registration order, and the realtime
    // tracing plugins finish their span in `end`.
    for (const Plugin of OpenAiRealtimeLLMObsPlugins) {
      plugins[Plugin.id] = Plugin
    }

    for (const Plugin of OpenAiRealtimeTracingPlugins) {
      plugins[Plugin.id] = Plugin
    }

    return plugins
  }
}

module.exports = OpenAiPlugin
