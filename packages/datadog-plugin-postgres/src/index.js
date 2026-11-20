'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const PostgresNativePlugin = require('./native')
const PostgresQueryPlugin = require('./query')

class PostgresPlugin extends CompositePlugin {
  static id = 'postgres'
  static plugins = {
    query: PostgresQueryPlugin,
    native: PostgresNativePlugin,
  }
}

module.exports = PostgresPlugin
