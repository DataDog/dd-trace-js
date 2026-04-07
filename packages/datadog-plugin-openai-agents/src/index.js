'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const llmobsPlugins = require('../../dd-trace/src/llmobs/plugins/openai-agents')
const internalPlugins = require('./internal')
const clientPlugins = require('./client')

class OpenaiAgentsPlugin extends CompositePlugin {
  static id = 'openai-agents'
  // LLMObs plugins must be registered before tracing plugins for the same operations.
  // The span-finish diagnostic channel fires synchronously when span.finish() is called,
  // so setLLMObsTags must run before the tracing plugin's asyncEnd calls span.finish().
  static plugins = [...llmobsPlugins, ...internalPlugins, ...clientPlugins]
}

module.exports = OpenaiAgentsPlugin
