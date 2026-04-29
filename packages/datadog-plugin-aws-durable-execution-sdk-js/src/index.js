'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const executePlugin = require('./execute')
const internalPlugin = require('./internal')
const clientPlugin = require('./client')
const checkpointPlugin = require('./checkpoint')

class AwsDurableExecutionSdkJsPlugin extends CompositePlugin {
  static id = 'aws-durable-execution-sdk-js'
  static plugins = {
    execute: executePlugin,
    ...internalPlugin,
    client: clientPlugin,
    checkpoint: checkpointPlugin,
  }
}

module.exports = AwsDurableExecutionSdkJsPlugin
