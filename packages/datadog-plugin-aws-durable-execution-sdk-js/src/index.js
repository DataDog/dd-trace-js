'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const handlerPlugin = require('./handler')
const contextPlugin = require('./context')
const clientPlugin = require('./client')
const checkpointPlugin = require('./checkpoint')

class AwsDurableExecutionSdkJsPlugin extends CompositePlugin {
  static id = 'aws-durable-execution-sdk-js'
  static plugins = {
    handler: handlerPlugin,
    ...contextPlugin,
    client: clientPlugin,
    checkpoint: checkpointPlugin,
  }
}

module.exports = AwsDurableExecutionSdkJsPlugin
