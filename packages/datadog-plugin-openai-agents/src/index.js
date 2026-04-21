'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const llmobsPlugins = require('../../dd-trace/src/llmobs/plugins/openai-agents')
const internalPlugins = require('./internal')
const clientPlugins = require('./client')
const agentSpanPlugins = require('./agent-span')

const plugins = {}

// LLMObs plugins must be registered before tracing plugins for the same operations.
// The span-finish diagnostic channel fires synchronously when span.finish() is called,
// so setLLMObsTags must run before the tracing plugin's asyncEnd calls span.finish().
for (const Plugin of llmobsPlugins) {
  plugins[Plugin.id] = Plugin
}
for (const Plugin of internalPlugins) {
  plugins[Plugin.id] = Plugin
}
for (const Plugin of clientPlugins) {
  plugins[Plugin.id] = Plugin
}

// Agent-span plugins intercept agents-core's MultiTracingProcessor lifecycle
// to emit a per-agent span parented via the SDK's own spanId/parentId chain.
// This adds the multi-agent handoff hierarchy the function-level `run` hook
// cannot produce — no existing span or tag is replaced.
for (const Plugin of agentSpanPlugins) {
  plugins[Plugin.id] = Plugin
}

class OpenaiAgentsPlugin extends CompositePlugin {
  static id = 'openai-agents'
  static plugins = plugins
}

module.exports = OpenaiAgentsPlugin
