'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const internalPlugin = require('./internal')
const clientPlugin = require('./client')

class OpenaiAgentsPlugin extends CompositePlugin {
  static id = 'openai-agents'
  static plugins = {
    ...internalPlugin,
    ...clientPlugin,
  }
}

module.exports = OpenaiAgentsPlugin
