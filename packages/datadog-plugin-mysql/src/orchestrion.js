'use strict'

const dc = require('dc-polyfill')
const { storage } = require('../../datadog-core')
const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const {
  channels: databaseChannels,
  DatabaseQueryProcessor,
} = require('../../dd-trace/src/events/database')
const { runSemanticStart } = require('../../dd-trace/src/events/orchestrion')
const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

const legacyStorage = storage('legacy')

// IAST SQL-injection analysis still subscribes to these legacy channels. The
// Orchestrion path republishes them so analyzer cardinality, payload shape and
// store timing stay identical after the hook mechanism moved.
const iastQueryStartCh = dc.channel('apm:mysql:query:start')
const poolQueryStartCh = dc.channel('datadog:mysql:pool:query:start')
const poolQueryFinishCh = dc.channel('datadog:mysql:pool:query:finish')

/**
 * The source adapter for the only span-producing semantic path. Upstream
 * `Pool.query` dispatches through `getConnection` to `Connection.query`, so
 * this fires for both direct and pooled queries; the pool adapter stays
 * span-free.
 *
 * `Connection.prototype.query` is wrapped with a `Sync` operator: `:start`
 * enters the store returned by the semantic processor and applies its DBM
 * mutation, while `:end` receives the returned `Query`. The adapter publishes
 * semantic completion at the query's real boundary (its `_callback` or `end`
 * event), matching the legacy shimmer behavior.
 */
class MysqlQueryProcessor extends DatabaseQueryProcessor {
  static id = 'mysql'
  static system = 'mysql'
}

class MysqlConnectionQueryPlugin extends TracingPlugin {
  static id = 'mysql'
  static prefix = 'tracing:orchestrion:mysql:Connection_query'

  bindStart (ctx) {
    const args = ctx.arguments
    const sql = args[0].sql || args[0]
    const store = runSemanticStart(ctx, databaseChannels.queryStart, normalizeConnectionQuery)

    // `ctx.arguments` is the same array the wrapper applies to the original
    // method, so writing the DBM-injected SQL here is visible to mysql.
    if (args[0].sql) {
      args[0].sql = ctx.data.statement
    } else {
      args[0] = ctx.data.statement
    }

    // IAST SQL-injection analysis (unchanged channel), original SQL text.
    iastQueryStartCh.publish({ sql })

    return store
  }

  end (ctx) {
    const query = ctx.result
    const span = ctx.context?.span
    if (!query || !span) return

    if (query._callback) {
      const callback = query._callback
      query._callback = function (error, result) {
        ctx.result = result
        if (error) {
          ctx.error = error
          databaseChannels.queryError.publish(ctx)
        }
        databaseChannels.queryFinish.publish(ctx)

        // Run the user callback in the caller's context, matching the legacy
        // `apm:mysql:query:finish` bindFinish (which returned `ctx.parentStore`).
        return legacyStorage.run(ctx.parentStore, () => callback.apply(this, arguments))
      }
    } else {
      query.once('end', () => databaseChannels.queryFinish.publish(ctx))
    }
  }

  error (ctx) {
    databaseChannels.queryError.publish(ctx)
    databaseChannels.queryFinish.publish(ctx)
  }
}

/**
 * Context/IAST-only. `Pool.query` returns a `Query` synchronously and its
 * callback is optional, so a `Sync` operator lets us run the pool-query start
 * handling exactly once per call (including no-callback queries). It creates NO
 * span and does NO DBM injection; the span and DBM come from the dispatched
 * `Connection.query`. It only republishes the IAST pool channels, preserving
 * their delayed finish timing (after the callback, or on a thenable result).
 */
class MysqlPoolQueryPlugin extends TracingPlugin {
  static id = 'mysql'
  static prefix = 'tracing:orchestrion:mysql:Pool_query'

  bindStart (ctx) {
    const args = ctx.arguments
    ctx.sql = args[0].sql || args[0]

    // Publish in the caller context so IAST's setStoreAndAnalyze `enterWith`
    // takes effect; enter the resulting store for the pool-query execution.
    poolQueryStartCh.publish(ctx)
    const store = legacyStorage.getStore()

    const callback = args[args.length - 1]
    if (typeof callback === 'function') {
      args[args.length - 1] = function (...callbackArgs) {
        poolQueryFinishCh.publish(ctx)
        return callback.apply(this, callbackArgs)
      }
    }

    return store
  }

  end (ctx) {
    const result = ctx.result
    if (result && typeof result.then === 'function') {
      const finish = () => poolQueryFinishCh.publish(ctx)
      result.then(finish, finish)
    }
  }
}

/**
 * Context-only (no span). Captures the caller's store on `:start` and returns it
 * on `:asyncStart`, so a pooled/queued connection callback runs in the caller's
 * async context: the Orchestrion equivalent of the legacy connection:start
 * capture plus connection:finish bind.
 */
class MysqlPoolGetConnectionPlugin extends TracingPlugin {
  static id = 'mysql'
  static prefix = 'tracing:orchestrion:mysql:Pool_getConnection'

  bindStart (ctx) {
    ctx.currentStore = legacyStorage.getStore()

    return ctx.currentStore
  }

  bindAsyncStart (ctx) {
    return ctx.currentStore
  }
}

class MysqlOrchestrionPlugin extends CompositePlugin {
  static id = 'mysql'
  static plugins = {
    queryProcessor: MysqlQueryProcessor,
    connectionQuery: MysqlConnectionQueryPlugin,
    poolQuery: MysqlPoolQueryPlugin,
    poolGetConnection: MysqlPoolGetConnectionPlugin,
  }
}

function normalizeConnectionQuery (ctx) {
  const args = ctx.arguments

  ctx.v = 1
  ctx.kind = 'database'
  ctx.operation = 'query'
  ctx.source = MYSQL_SOURCE
  ctx.data = {
    statement: args[0].sql || args[0],
    connection: ctx.self.config,
  }

  return ctx
}

const MYSQL_SOURCE = {
  integration: 'mysql',
  system: 'mysql',
}

module.exports = MysqlOrchestrionPlugin
