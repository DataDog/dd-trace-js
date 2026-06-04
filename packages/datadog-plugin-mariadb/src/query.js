'use strict'

const { storage } = require('../../datadog-core')
const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const DatabasePlugin = require('../../dd-trace/src/plugins/database')

/**
 * Symbol key used to attach the in-flight DB span to a mariadb `Command`
 * instance. The constructor :end handler sets it; the `successEnd` /
 * `throwError` channel handlers read and clear it. Symbol-keyed so it
 * doesn't collide with anything the lib enumerates.
 */
const DD_SPAN = Symbol('dd-mariadb-span')

/**
 * Symbol key used to stash the caller's async-context store on a mariadb
 * `Command` instance at construction time, so the completion channels can
 * restore it inside the user callback. Needed because v2's `_queryCallback`
 * is an arrow function assigned to a `this` property; orchestrion's
 * arrow-function wrap cannot recover call-site arity and misroutes
 * `(sql, cb)` calls to the promise path, dropping `:asyncStart`. Binding
 * at `Command.successEnd` / `Command.throwError` re-establishes context
 * synchronously around the `this.resolve(...)` / `this.reject(...)` call
 * that fires the user callback.
 */
const DD_PARENT_STORE = Symbol('dd-mariadb-parent-store')

// ---------------------------------------------------------------------------
// Method-level context-propagation plugins.
//
// The user-facing API hooks (`ConnectionCallback.query`, `PoolCallback.execute`,
// `PrepareResultPacket.execute`, etc.) keep their orchestrion entries so that
// `wrapCallback`'s `asyncStart.runStores` can rebind the parent store inside
// user callbacks. The plugin captures `parentStore` at `:start` and returns
// it at `:asyncStart`; it deliberately does NOT create or finish spans —
// span lifecycle is owned by the Command-level plugins below.
// ---------------------------------------------------------------------------

class MariadbQueryPlugin extends DatabasePlugin {
  static id = 'mariadb'
  static system = 'mariadb'
  static operation = 'query'

  /**
   * Capture the user's active store so `bindAsyncStart` can restore it when
   * the user callback fires. Returning the same store leaves the active
   * context unchanged for the wrapped function body.
   *
   * @param {object} ctx - Orchestrion channel context
   * @returns {object | undefined}
   */
  bindStart (ctx) {
    ctx.parentStore = storage('legacy').getStore()
    return ctx.parentStore
  }

  /**
   * Restore the parent async context inside the user callback so that user
   * code sees the same active span as before the query was called.
   *
   * @param {object} ctx - Orchestrion channel context
   * @returns {object | undefined}
   */
  bindAsyncStart (ctx) {
    return ctx.parentStore
  }
}

class ConnectionCallbackQueryPlugin extends MariadbQueryPlugin {
  static id = 'mariadb'
  static prefix = 'tracing:orchestrion:mariadb:ConnectionCallback_query'
}

class ConnectionCallbackExecutePlugin extends MariadbQueryPlugin {
  static id = 'mariadb'
  static prefix = 'tracing:orchestrion:mariadb:ConnectionCallback_execute'
}

class ConnectionPromiseQueryPlugin extends MariadbQueryPlugin {
  static id = 'mariadb'
  static prefix = 'tracing:orchestrion:mariadb:ConnectionPromise_query'
}

class ConnectionPromiseExecutePlugin extends MariadbQueryPlugin {
  static id = 'mariadb'
  static prefix = 'tracing:orchestrion:mariadb:ConnectionPromise_execute'
}

class PoolCallbackQueryPlugin extends MariadbQueryPlugin {
  static id = 'mariadb'
  static prefix = 'tracing:orchestrion:mariadb:PoolCallback_query'
}

class PoolCallbackExecutePlugin extends MariadbQueryPlugin {
  static id = 'mariadb'
  static prefix = 'tracing:orchestrion:mariadb:PoolCallback_execute'
}

class PoolPromiseQueryPlugin extends MariadbQueryPlugin {
  static id = 'mariadb'
  static prefix = 'tracing:orchestrion:mariadb:PoolPromise_query'
}

class PoolPromiseExecutePlugin extends MariadbQueryPlugin {
  static id = 'mariadb'
  static prefix = 'tracing:orchestrion:mariadb:PoolPromise_execute'
}

class V2ConnectionQueryPromisePlugin extends MariadbQueryPlugin {
  static id = 'mariadb'
  static prefix = 'tracing:orchestrion:mariadb:v2Connection_queryPromise'
}

class V2ConnectionQueryPlugin extends MariadbQueryPlugin {
  static id = 'mariadb'
  static prefix = 'tracing:orchestrion:mariadb:v2Connection_query'
}

class V2ConnectionQueryCallbackPlugin extends MariadbQueryPlugin {
  static id = 'mariadb'
  static prefix = 'tracing:orchestrion:mariadb:v2Connection_queryCallback'
}

class V2PoolBaseQueryPlugin extends MariadbQueryPlugin {
  static id = 'mariadb'
  static prefix = 'tracing:orchestrion:mariadb:v2PoolBase_query'
}

class PreparedStatementCallbackExecutePlugin extends MariadbQueryPlugin {
  static id = 'mariadb'
  static prefix = 'tracing:orchestrion:mariadb:PrepareResultPacket_execute'
}

// ---------------------------------------------------------------------------
// Command-level span lifecycle.
//
// `Query` / `Execute` constructors → span creation (orchestrion 0.13 rewrites
// the `super()`-calling constructor correctly; the wrapper's runStores binds
// the span store for the synchronous constructor body).
//
// `Command.prototype.successEnd` / `Command.prototype.throwError` → span
// finish. These are class methods on the base `Command` class, called
// exactly once per command on the success / error path respectively,
// regardless of whether the user invoked the callback API, the promise API,
// or fire-and-forget.
//
// The span travels on the Command instance via a Symbol-keyed property so
// the construct and finish channels can find it on the same `ctx.self`.
// ---------------------------------------------------------------------------

class MariadbCommandPlugin extends DatabasePlugin {
  static id = 'mariadb'
  static system = 'mariadb'
  static operation = 'query'

  constructor () {
    super(...arguments)

    const prefix = this.constructor.prefix

    // Wire span creation to `:end` rather than `:start` because the constructor
    // signature differs across mariadb versions (v2 and v3.0.x take
    // `(resolve, reject, cmdOpts, connOpts, sql, values)`; v3.4+ takes
    // `(resolve, reject, connOpts, cmdParam)`), but every version ends up
    // populating `this.sql` and `this.opts` by the time super() returns —
    // and `ctx.self` is set in the wrapper's finally block, just before
    // :end fires. Reading from `ctx.self` keeps a single code path.
    this.addSub(`${prefix}:end`, ctx => this.startSpanFromCommand(ctx))
  }

  /**
   * Returns the connection config to use for span metadata.
   * v2 overrides this because configAssign strips host/user/database/port from cmd.opts.
   *
   * @param {object} ctx - Orchestrion channel context
   * @param {object} cmd - Command instance (ctx.self)
   * @returns {object}
   */
  getConf (ctx, cmd) {
    return cmd.opts || {}
  }

  startSpanFromCommand (ctx) {
    const cmd = ctx.self
    if (!cmd) return

    const conf = this.getConf(ctx, cmd)
    const sql = cmd.sql
    const service = this.serviceName({ pluginConfig: this.config, dbConfig: conf, system: this.system })

    const span = this.startSpan(this.operationName(), {
      service,
      resource: sql,
      type: 'sql',
      kind: 'client',
      meta: {
        'db.type': this.system,
        'db.user': conf.user,
        'db.name': conf.database,
        'out.host': conf.host,
        [CLIENT_PORT_KEY]: conf.port,
      },
      childOf: this.activeSpan,
    }, ctx)

    cmd.sql = this.injectDbmQuery(span, sql, service.name)
    cmd[DD_SPAN] = span
    // Stash the caller's store so the completion plugins can re-enter it
    // when the user callback fires (see DD_PARENT_STORE rationale above).
    // At this point we are still synchronously inside the user-facing
    // query method, so the active legacy store IS the caller's store.
    cmd[DD_PARENT_STORE] = storage('legacy').getStore()
  }
}

class QueryCommandPlugin extends MariadbCommandPlugin {
  static id = 'mariadb'
  static prefix = 'tracing:orchestrion:mariadb:Query_construct'
}

class ExecuteCommandPlugin extends MariadbCommandPlugin {
  static id = 'mariadb'
  static prefix = 'tracing:orchestrion:mariadb:Execute_construct'
}

class V2QueryCommandPlugin extends MariadbCommandPlugin {
  static id = 'mariadb'
  static prefix = 'tracing:orchestrion:mariadb:v2Query_construct'

  /**
   * v2 configAssign strips host/user/database/port from this.opts;
   * the raw connOpts is passed as constructor argument index 3.
   *
   * @param {object} ctx - Orchestrion channel context
   * @returns {object}
   */
  getConf (ctx) {
    return ctx.arguments?.[3] || {}
  }
}

/**
 * Base class for the protocol-level completion plugins. Listens on the
 * `:start` channel of either `Command.successEnd` or `Command.throwError`,
 * pulls the span off `ctx.self`, tags an error if applicable, and finishes.
 *
 * Extends `DatabasePlugin` so we inherit `tagPeerService` (used by
 * `withPeerService` tests) without reimplementing it.
 */
class MariadbCommandCompletionPlugin extends DatabasePlugin {
  static id = 'mariadb'
  static system = 'mariadb'
  static operation = 'query'

  constructor () {
    super(...arguments)

    const prefix = this.constructor.prefix
    this.addSub(`${prefix}:start`, ctx => this.finishSpan(ctx))
  }

  /**
   * Re-enter the caller's async store for the duration of `successEnd` /
   * `throwError`. This is where mariadb synchronously fires the user
   * callback (`this.resolve(rows)` / `this.reject(err)`), so binding here
   * is what restores the parent span context inside that callback.
   * Required for the v2 callback path, where orchestrion's `_queryCallback`
   * wrap cannot detect the user callback (arrow + variable arity) and
   * therefore never emits `:asyncStart`. Idempotent for v3, which also
   * restores context at its own `ConnectionCallback.query:asyncStart`.
   *
   * @param {object} ctx - Orchestrion channel context for the completion call
   * @returns {object | undefined}
   */
  bindStart (ctx) {
    return ctx.self?.[DD_PARENT_STORE]
  }

  /**
   * @param {object} ctx - Orchestrion channel context for the completion call
   */
  finishSpan (ctx) {
    const cmd = ctx.self
    if (!cmd) return
    const span = cmd[DD_SPAN]
    if (!span) return
    cmd[DD_SPAN] = undefined
    cmd[DD_PARENT_STORE] = undefined

    if (this.constructor.isError && ctx.arguments && ctx.arguments[0]) {
      this.addError(ctx.arguments[0], span)
    }

    this.tagPeerService(span)
    span.finish()
  }
}

class CommandSuccessEndPlugin extends MariadbCommandCompletionPlugin {
  static id = 'mariadb'
  static prefix = 'tracing:orchestrion:mariadb:Command_successEnd'
  static isError = false
}

class CommandThrowErrorPlugin extends MariadbCommandCompletionPlugin {
  static id = 'mariadb'
  static prefix = 'tracing:orchestrion:mariadb:Command_throwError'
  static isError = true
}

module.exports = [
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
  QueryCommandPlugin,
  ExecuteCommandPlugin,
  V2QueryCommandPlugin,
  CommandSuccessEndPlugin,
  CommandThrowErrorPlugin,
]
