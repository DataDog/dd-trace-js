'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const connectionPlugins = require('./connection')
const queryPlugins = require('./query')

const [
  CreateConnectionPlugin,
  CreatePoolPlugin,
  PoolGetConnectionPlugin,
  PoolCreateConnectionPlugin,
  V2ConnectionPlugin,
  V2PoolBasePlugin,
  V2PoolBaseGetConnectionPlugin,
] = connectionPlugins

const [
  MariadbQueryContextPlugin,
  QueryCommandPlugin,
  V2QueryCommandPlugin,
  CommandCompletionPlugin,
] = queryPlugins

class MariadbPlugin extends CompositePlugin {
  static id = 'mariadb'
  static plugins = {
    createConnection: CreateConnectionPlugin,
    createPool: CreatePoolPlugin,
    poolGetConnection: PoolGetConnectionPlugin,
    poolCreateConnection: PoolCreateConnectionPlugin,
    v2Connection: V2ConnectionPlugin,
    v2PoolBase: V2PoolBasePlugin,
    v2PoolGetConnection: V2PoolBaseGetConnectionPlugin,
    queryContext: MariadbQueryContextPlugin,
    queryCommand: QueryCommandPlugin,
    v2QueryCommand: V2QueryCommandPlugin,
    commandCompletion: CommandCompletionPlugin,
  }
}

module.exports = MariadbPlugin
