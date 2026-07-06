'use strict'

const dc = require('dc-polyfill')
const { storage } = require('../../datadog-core')
const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const DatabasePlugin = require('../../dd-trace/src/plugins/database')
const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const { startQuerySpan } = require('./shared')

const legacyStorage = storage('legacy')

// IAST SQL-injection analysis still subscribes to these legacy channels. The
// Orchestrion path republishes them so analyzer cardinality, payload shape and
// store timing stay identical after the hook mechanism moved.
const iastQueryStartCh = dc.channel('apm:mysql:query:start')
const poolQueryStartCh = dc.channel('datadog:mysql:pool:query:start')
const poolQueryFinishCh = dc.channel('datadog:mysql:pool:query:finish')

/**
 * The only span-creating path. Upstream `Pool.query` dispatches through
 * `getConnection` to `Connection.query`, so this fires for both direct and
 * pooled queries; the pool subplugin must therefore stay span-free.
 *
 * `Connection.prototype.query` is wrapped with a `Sync` operator: `:start`
 * establishes the span store and mutates the args (DBM injection), `:end` fires
 * at synchronous return with `ctx.result` being the returned `Query`. The span
 * finish is deferred to the query's real completion boundary (its `_callback`
 * or its `end` event), matching the legacy shimmer behavior.
 */
class MysqlConnectionQueryPlugin extends DatabasePlugin {
  static id = 'mysql'
  static system = 'mysql'
  static prefix = 'tracing:orchestrion:mysql:Connection_query'

  bindStart (ctx) {
    const args = ctx.arguments
    const sql = args[0].sql || args[0]
    ctx.sql = sql
    ctx.conf = ctx.self.config

    const store = startQuerySpan(this, ctx)

    // `ctx.arguments` is the same array the wrapper applies to the original
    // method, so writing the DBM-injected SQL here is visible to mysql.
    if (args[0].sql) {
      args[0].sql = ctx.sql
    } else {
      args[0] = ctx.sql
    }

    // IAST SQL-injection analysis (unchanged channel), original SQL text.
    iastQueryStartCh.publish({ sql })

    return store
  }

  end (ctx) {
    const query = ctx.result
    const span = ctx.currentStore?.span
    if (!query || !span) return

    if (query._callback) {
      const callback = query._callback
      const plugin = this
      query._callback = function (error, result) {
        ctx.result = result
        if (error) {
          ctx.error = error
          plugin.error(ctx)
        }
        plugin.finish(ctx)

        // Run the user callback in the caller's context, matching the legacy
        // `apm:mysql:query:finish` bindFinish (which returned `ctx.parentStore`).
        return legacyStorage.run(ctx.parentStore, () => callback.apply(this, arguments))
      }
    } else {
      query.once('end', () => this.finish(ctx))
    }
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
    connectionQuery: MysqlConnectionQueryPlugin,
    poolQuery: MysqlPoolQueryPlugin,
    poolGetConnection: MysqlPoolGetConnectionPlugin,
  }
}

module.exports = MysqlOrchestrionPlugin
