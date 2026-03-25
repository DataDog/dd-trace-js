'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const llmobsPlugin = require('../../dd-trace/src/llmobs/plugins/openai-agents')
const internalPlugin = require('./internal')
const clientPlugin = require('./client')

class OpenaiAgentsPlugin extends CompositePlugin {
  static id = 'openai-agents'
  static plugins = {
    ...internalPlugin,
    ...llmobsPlugin,
    ...clientPlugin,
  }
}

module.exports = OpenaiAgentsPlugin
