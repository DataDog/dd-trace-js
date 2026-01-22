'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const internalPlugin = require('./internal')

class LanggraphPlugin extends CompositePlugin {
  static id = 'langgraph'
  static plugins = {
    ...internalPlugin
  }
}

module.exports = LanggraphPlugin
