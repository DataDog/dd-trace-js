'use strict'

const shimmer = require('../../datadog-shimmer')
const { addHook, channel } = require('./helpers/instrument')

const statementRunStartCh = channel('tracing:orchestrion:better-sqlite3:Statement_run:start')
const statementRunFinishCh = channel('tracing:orchestrion:better-sqlite3:Statement_run:finish')
const statementRunErrorCh = channel('tracing:orchestrion:better-sqlite3:Statement_run:error')

const statementGetStartCh = channel('tracing:orchestrion:better-sqlite3:Statement_get:start')
const statementGetFinishCh = channel('tracing:orchestrion:better-sqlite3:Statement_get:finish')
const statementGetErrorCh = channel('tracing:orchestrion:better-sqlite3:Statement_get:error')

const statementAllStartCh = channel('tracing:orchestrion:better-sqlite3:Statement_all:start')
const statementAllFinishCh = channel('tracing:orchestrion:better-sqlite3:Statement_all:finish')
const statementAllErrorCh = channel('tracing:orchestrion:better-sqlite3:Statement_all:error')

const statementIterateStartCh = channel('tracing:orchestrion:better-sqlite3:Statement_iterate:start')
const statementIterateFinishCh = channel('tracing:orchestrion:better-sqlite3:Statement_iterate:finish')
const statementIterateErrorCh = channel('tracing:orchestrion:better-sqlite3:Statement_iterate:error')

const databaseExecStartCh = channel('tracing:orchestrion:better-sqlite3:Database_exec:start')
const databaseExecFinishCh = channel('tracing:orchestrion:better-sqlite3:Database_exec:finish')
const databaseExecErrorCh = channel('tracing:orchestrion:better-sqlite3:Database_exec:error')

function createSyncWrapper (startCh, finishCh, errorCh) {
  return function wrapMethod (original) {
    return function wrappedMethod () {
      if (!startCh.hasSubscribers) {
        return original.apply(this, arguments)
      }

      const ctx = {
        self: this,
        arguments: [...arguments]
      }

      return startCh.runStores(ctx, () => {
        try {
          const result = original.apply(this, arguments)
          ctx.result = result
          finishCh.publish(ctx)
          return result
        } catch (err) {
          ctx.error = err
          errorCh.publish(ctx)
          finishCh.publish(ctx)
          throw err
        }
      })
    }
  }
}

addHook({
  name: 'better-sqlite3',
  versions: ['>=12.6.2']
}, (Database) => {
  // Wrap Database.prototype.exec
  shimmer.wrap(Database.prototype, 'exec', createSyncWrapper(
    databaseExecStartCh,
    databaseExecFinishCh,
    databaseExecErrorCh
  ))

  // We also need to wrap Statement methods. The Statement class is not directly
  // exported, but we can get it by calling prepare() on a Database instance.
  // However, since Statement is returned from prepare(), we wrap at the prepare level.

  const originalPrepare = Database.prototype.prepare

  Database.prototype.prepare = function wrappedPrepare () {
    const stmt = originalPrepare.apply(this, arguments)

    // The statement object has its own prototype that needs wrapping
    // Only wrap once per statement type
    const stmtProto = Object.getPrototypeOf(stmt)

    if (!stmtProto.__dd_wrapped) {
      stmtProto.__dd_wrapped = true

      shimmer.wrap(stmtProto, 'run', createSyncWrapper(
        statementRunStartCh,
        statementRunFinishCh,
        statementRunErrorCh
      ))

      shimmer.wrap(stmtProto, 'get', createSyncWrapper(
        statementGetStartCh,
        statementGetFinishCh,
        statementGetErrorCh
      ))

      shimmer.wrap(stmtProto, 'all', createSyncWrapper(
        statementAllStartCh,
        statementAllFinishCh,
        statementAllErrorCh
      ))

      shimmer.wrap(stmtProto, 'iterate', createSyncWrapper(
        statementIterateStartCh,
        statementIterateFinishCh,
        statementIterateErrorCh
      ))
    }

    return stmt
  }

  return Database
})
