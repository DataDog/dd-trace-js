'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const internalPlugin = require('./internal')
const clientPlugin = require('./client')
const llmobsPlugin = require('../../dd-trace/src/llmobs/plugins/openai-agents')

class OpenaiAgentsPlugin extends CompositePlugin {
  static id = 'openai-agents'
  static plugins = {
    ...internalPlugin,
    ...llmobsPlugin,
    ...clientPlugin,
  }
}

module.exports = OpenaiAgentsPlugin
