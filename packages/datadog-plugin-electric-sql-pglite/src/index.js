'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const clientPlugins = require('./client')

const plugins = {}

for (const Plugin of clientPlugins) {
  plugins[Plugin.id] = Plugin
}

class ElectricSqlPglitePlugin extends CompositePlugin {
  static id = 'electric-sql-pglite'
  static plugins = plugins
}

module.exports = ElectricSqlPglitePlugin
