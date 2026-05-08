'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const clientPlugin = require('./client')
const internalPlugin = require('./internal')

class GenkitPlugin extends CompositePlugin {
  static id = 'genkit'
  static plugins = {
    ...clientPlugin,
    internal: internalPlugin
  }
}

module.exports = GenkitPlugin
