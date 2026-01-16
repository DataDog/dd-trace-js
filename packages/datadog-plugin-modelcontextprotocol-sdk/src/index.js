'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const clientPlugin = require('./client')
const serverPlugin = require('./server')

class ModelcontextprotocolSdkPlugin extends CompositePlugin {
  static id = 'modelcontextprotocol-sdk'
  static plugins = {
    ...clientPlugin,
    ...serverPlugin
  }
}

module.exports = ModelcontextprotocolSdkPlugin
