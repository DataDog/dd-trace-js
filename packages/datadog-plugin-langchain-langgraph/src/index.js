'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const clientPlugin = require('./client')
const internalPlugin = require('./internal')

class LangchainLanggraphPlugin extends CompositePlugin {
  static id = 'langchain-langgraph'
  static plugins = {
    ...clientPlugin,
    internal: internalPlugin
  }
}

module.exports = LangchainLanggraphPlugin
