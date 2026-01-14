'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const LLMObsPlugins = require('../../dd-trace/src/llmobs/plugins/openai-agents')
const ClientPlugins = require('./client')
const InternalPlugins = require('./internal')

class OpenaiAgentsPlugin extends CompositePlugin {
  static id = 'openai-agents'
  static get plugins () {
    return {
      ...LLMObsPlugins,
      // APM tracing plugins
      ...ClientPlugins,
      ...InternalPlugins,
    }
  }
}

module.exports = OpenaiAgentsPlugin
