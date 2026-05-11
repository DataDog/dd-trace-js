'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const checkpointPlugin = require('./checkpoint')
const clientPlugin = require('./client')
const contextPlugins = require('./context')
const handlerPlugin = require('./handler')

class AwsDurableExecutionSdkJsPlugin extends CompositePlugin {
  static id = 'aws-durable-execution-sdk-js'
  static plugins = {
    handler: handlerPlugin,
    client: clientPlugin,
    checkpoint: checkpointPlugin,
    ...contextPlugins,
  }
}

module.exports = AwsDurableExecutionSdkJsPlugin
