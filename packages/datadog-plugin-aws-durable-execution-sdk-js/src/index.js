'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const serverPlugin = require('./server')
const internalPlugin = require('./internal')
const clientPlugin = require('./client')

class AwsDurableExecutionSdkJsPlugin extends CompositePlugin {
  static id = 'aws-durable-execution-sdk-js'
  static plugins = {
    server: serverPlugin,
    ...internalPlugin,
    client: clientPlugin
  }
}

module.exports = AwsDurableExecutionSdkJsPlugin
