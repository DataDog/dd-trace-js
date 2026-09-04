'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const internalPlugin = require('./internal')

class DataloaderPlugin extends CompositePlugin {
  static id = 'dataloader'
  static plugins = {
    ...internalPlugin,
  }
}

module.exports = DataloaderPlugin
