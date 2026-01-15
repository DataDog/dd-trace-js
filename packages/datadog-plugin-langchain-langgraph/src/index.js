'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const clientPlugin = require('./client')

class LangchainLanggraphPlugin extends CompositePlugin {
  static id = 'langchain-langgraph'
  static plugins = {
    ...clientPlugin
  }
}

module.exports = LangchainLanggraphPlugin
