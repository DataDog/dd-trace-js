'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const internalPlugin = require('./internal')
const serverPlugin = require('./server')

class GraphqlPlugin extends CompositePlugin {
  static id = 'graphql'
  static plugins = {
    ...internalPlugin,
    execute: serverPlugin,
  }
}

module.exports = GraphqlPlugin
