'use strict'

const DatabasePlugin = require('../../dd-trace/src/plugins/database')

class BaseBetterSqlite3ClientPlugin extends DatabasePlugin {
  static id = 'better-sqlite3'
  static system = 'sqlite'
  static prefix = 'tracing:orchestrion:better-sqlite3:Statement_run'
  static operationSuffix = 'run'

  bindStart (ctx) {
    const sql = ctx.self?.source
    const dbName = ctx.self?.database?.name || ':memory:'

    this.startSpan(`better-sqlite3.${this.constructor.operationSuffix}`, {
      type: 'sql',
      kind: 'client',
      resource: sql,
      meta: {
        component: 'better-sqlite3',
        'db.type': 'sqlite',
        'db.name': dbName,
        'db.statement': sql
      }
    }, ctx)

    return ctx.currentStore
  }

  // You may modify this method, but the guard below is REQUIRED and MUST NOT be removed!
  finish (ctx) {
    // CRITICAL GUARD - DO NOT REMOVE: Ensures span only finishes when operation completes
    if (!ctx.hasOwnProperty('result') && !ctx.hasOwnProperty('error')) return

    super.finish(ctx)
  }
}

class StatementGetPlugin extends BaseBetterSqlite3ClientPlugin {
  static prefix = 'tracing:orchestrion:better-sqlite3:Statement_get'
  static operationSuffix = 'get'
}

class StatementAllPlugin extends BaseBetterSqlite3ClientPlugin {
  static prefix = 'tracing:orchestrion:better-sqlite3:Statement_all'
  static operationSuffix = 'all'
}

class StatementIteratePlugin extends BaseBetterSqlite3ClientPlugin {
  static prefix = 'tracing:orchestrion:better-sqlite3:Statement_iterate'
  static operationSuffix = 'iterate'
}

class DatabaseExecPlugin extends BaseBetterSqlite3ClientPlugin {
  static prefix = 'tracing:orchestrion:better-sqlite3:Database_exec'
  static operationSuffix = 'exec'

  bindStart (ctx) {
    const sql = ctx.arguments?.[0]
    const dbName = ctx.self?.name || ':memory:'

    this.startSpan(`better-sqlite3.${this.constructor.operationSuffix}`, {
      type: 'sql',
      kind: 'client',
      resource: sql,
      meta: {
        component: 'better-sqlite3',
        'db.type': 'sqlite',
        'db.name': dbName,
        'db.statement': sql
      }
    }, ctx)

    return ctx.currentStore
  }
}

module.exports = {
  BaseBetterSqlite3ClientPlugin,
  StatementGetPlugin,
  StatementAllPlugin,
  StatementIteratePlugin,
  DatabaseExecPlugin
}
