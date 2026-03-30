'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const connectionPlugins = require('./connection')
const queryPlugins = require('./query')

const [
  CreateConnectionPlugin,
  CreatePoolPlugin,
  PoolGetConnectionPlugin,
  V2ConnectionPlugin,
  V2PoolBasePlugin,
  V2PoolBaseGetConnectionPlugin,
] = connectionPlugins

const [
  ConnectionCallbackQueryPlugin,
  ConnectionCallbackExecutePlugin,
  ConnectionPromiseQueryPlugin,
  ConnectionPromiseExecutePlugin,
  PoolCallbackQueryPlugin,
  PoolCallbackExecutePlugin,
  PoolPromiseQueryPlugin,
  PoolPromiseExecutePlugin,
  V2ConnectionQueryPromisePlugin,
  V2ConnectionQueryPlugin,
  V2ConnectionQueryCallbackPlugin,
  V2PoolBaseQueryPlugin,
  PreparedStatementCallbackExecutePlugin,
] = queryPlugins

class MariadbPlugin extends CompositePlugin {
  static id = 'mariadb'
  static plugins = {
    createConnection: CreateConnectionPlugin,
    createPool: CreatePoolPlugin,
    poolGetConnection: PoolGetConnectionPlugin,
    v2Connection: V2ConnectionPlugin,
    v2PoolBase: V2PoolBasePlugin,
    v2PoolGetConnection: V2PoolBaseGetConnectionPlugin,
    cbConnQuery: ConnectionCallbackQueryPlugin,
    cbConnExecute: ConnectionCallbackExecutePlugin,
    promiseConnQuery: ConnectionPromiseQueryPlugin,
    promiseConnExecute: ConnectionPromiseExecutePlugin,
    cbPoolQuery: PoolCallbackQueryPlugin,
    cbPoolExecute: PoolCallbackExecutePlugin,
    promisePoolQuery: PoolPromiseQueryPlugin,
    promisePoolExecute: PoolPromiseExecutePlugin,
    v2ConnQueryPromise: V2ConnectionQueryPromisePlugin,
    v2ConnQuery: V2ConnectionQueryPlugin,
    v2ConnQueryCallback: V2ConnectionQueryCallbackPlugin,
    v2PoolQuery: V2PoolBaseQueryPlugin,
    preparedStmtExecute: PreparedStatementCallbackExecutePlugin,
  }
}

module.exports = MariadbPlugin
