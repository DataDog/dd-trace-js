'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const {
  StatementGetPlugin,
  StatementAllPlugin,
  StatementIteratePlugin,
  DatabaseExecPlugin,
  BaseBetterSqlite3ClientPlugin
} = require('./client')

class BetterSqlite3Plugin extends CompositePlugin {
  static id = 'better-sqlite3'
  static get plugins () {
    return {
      run: BaseBetterSqlite3ClientPlugin,
      get: StatementGetPlugin,
      all: StatementAllPlugin,
      iterate: StatementIteratePlugin,
      exec: DatabaseExecPlugin
    }
  }
}

module.exports = BetterSqlite3Plugin
