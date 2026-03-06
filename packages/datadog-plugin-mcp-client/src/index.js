'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const clientPlugin = require('./client')

class McpClientPlugin extends CompositePlugin {
  static id = 'mcp-client'
  static plugins = {
    ...clientPlugin,
  }
}

module.exports = McpClientPlugin
