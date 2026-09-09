'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')

class DataloaderPlugin extends CompositePlugin {
  static id = 'dataloader'
  static plugins = require('./internal')
}

module.exports = DataloaderPlugin
