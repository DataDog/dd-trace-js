'use strict'

const { channel } = require('dc-polyfill')

const { storage } = require('../../datadog-core')
const DatabasePlugin = require('../../dd-trace/src/plugins/database')
const { startQuerySpan } = require('../../datadog-plugin-mysql/src/shared')

const DD_SPAN = Symbol('dd-mariadb-span')

// Stash caller's async-context store on the Command instance so completion
// channels can restore it inside the user callback. Needed because v2's
// _queryCallback is an arrow assigned to a this-property; orchestrion's
// arrow wrap misroutes (sql, cb) calls to the promise path, dropping
// :asyncStart. Binding at successEnd / throwError re-establishes context
// synchronously around the this.resolve / this.reject call.
const DD_PARENT_STORE = Symbol('dd-mariadb-parent-store')

const legacyStorage = storage('legacy')

/**
 * Store binding that intentionally bypasses Plugin's noop-store guard.
 *
 * Command completion can run on a pool socket async resource that was marked
 * noop to suppress connection-establishment spans. User query commands still
 * need to finish their already-created spans, so this binding restores only
 * the store stashed on those Command instances.
 */
class DirectStoreBinding {
  /**
   * @param {string} event - Diagnostic channel event name
   * @param {(ctx: object) => object | undefined} transform - Store transform
   */
  constructor (event, transform) {
    this._channel = channel(event)
    this._transform = transform
  }

  /**
   * Enables this store binding.
   *
   * @returns {void}
   */
  enable () {
    this._channel.bindStore(legacyStorage, this._transform)
  }

  /**
   * Disables this store binding.
   *
   * @returns {void}
   */
  disable () {
    this._channel.unbindStore(legacyStorage)
  }
}

class DirectSubscription {
  /**
   * @param {string} event - Diagnostic channel event name
   * @param {(ctx: object) => void} handler - Event handler
   */
  constructor (event, handler) {
    this._channel = channel(event)
    this._handler = handler
  }

  /**
   * Enables this subscription.
   *
   * @returns {void}
   */
  enable () {
    this._channel.subscribe(this._handler)
  }

  /**
   * Disables this subscription.
   *
   * @returns {void}
   */
  disable () {
    this._channel.unsubscribe(this._handler)
  }
}

// User-facing API channels that only need context propagation (no spans).
// A single plugin instance subscribes to all of them rather than one class
// per channel.
const USER_FACING_CHANNELS = [
  'ConnectionCallback_query',
  'ConnectionCallback_execute',
  'ConnectionPromise_query',
  'ConnectionPromise_execute',
  'PoolCallback_query',
  'PoolCallback_execute',
  'PoolPromise_query',
  'PoolPromise_execute',
  'v2Connection_queryPromise',
  'v2Connection_query',
  'v2Connection_queryCallback',
  'v2PoolBase_query',
  'PrepareResultPacket_execute',
]

// Subscribes to all user-facing query/execute channels and handles only
// context propagation — capturing parentStore at :start so that
// wrapCallback's asyncStart.runStores can restore it inside user callbacks.
// currentStore is a compatibility marker for restores that happen while the
// current async resource is intentionally marked noop.
// Span lifecycle is owned by the Command-level plugins below.
class MariadbQueryContextPlugin extends DatabasePlugin {
  static id = 'mariadb'
  static system = 'mariadb'
  static operation = 'query'

  constructor () {
    super(...arguments)
    for (const name of USER_FACING_CHANNELS) {
      const prefix = `tracing:orchestrion:mariadb:${name}`
      this.addBind(`${prefix}:start`, ctx => {
        ctx.parentStore = legacyStorage.getStore()
        ctx.currentStore = ctx.parentStore
        return ctx.parentStore
      })
      this.addBind(`${prefix}:asyncStart`, ctx => ctx.parentStore)
    }
  }
}

class MariadbCommandPlugin extends DatabasePlugin {
  static id = 'mariadb'
  static system = 'mariadb'
  static operation = 'query'
  static directCommandSubscription = true

  constructor () {
    super(...arguments)
    const prefix = this.constructor.prefix
    // Wire span creation to :end so ctx.self (the Command instance) is
    // populated — this.sql and this.opts are set by the time super() returns.
    this.addCommandSub(`${prefix}:end`, ctx => this.startSpanFromCommand(ctx))
  }

  /**
   * Adds a command-constructor subscription.
   *
   * @param {string} event - Diagnostic channel event name
   * @param {(ctx: object) => void} handler - Event handler
   * @returns {void}
   */
  addCommandSub (event, handler) {
    if (this.constructor.directCommandSubscription) {
      this._subscriptions.push(new DirectSubscription(event, handler))
    } else {
      this.addSub(event, handler)
    }
  }

  // Returns the connection config for span metadata.
  // V2QueryCommandPlugin overrides this because v2's configAssign strips
  // host/user/database/port from cmd.opts.
  getConf (ctx, cmd) {
    return cmd.opts || {}
  }

  startSpanFromCommand (ctx) {
    const cmd = ctx.self
    if (!cmd) return

    ctx.sql = cmd.sql
    ctx.conf = this.getConf(ctx, cmd)
    startQuerySpan(this, ctx, { childOf: this.activeSpan })

    cmd.sql = ctx.sql
    cmd[DD_SPAN] = ctx.currentStore?.span
    cmd[DD_PARENT_STORE] = ctx.parentStore?.noop ? undefined : ctx.parentStore
  }
}

// Handles both Query and Execute constructors — same span logic, different channel.
class QueryCommandPlugin extends MariadbCommandPlugin {
  static id = 'mariadb'
  static prefix = 'tracing:orchestrion:mariadb:Query_construct'

  constructor () {
    super(...arguments)
    this.addCommandSub('tracing:orchestrion:mariadb:Execute_construct:end', ctx => this.startSpanFromCommand(ctx))
  }
}

class V2QueryCommandPlugin extends MariadbCommandPlugin {
  static id = 'mariadb'
  static prefix = 'tracing:orchestrion:mariadb:v2Query_construct'
  static directCommandSubscription = false

  // v2 configAssign strips host/user/database/port from this.opts;
  // the raw connOpts is passed as constructor argument index 3.
  getConf (ctx) {
    return ctx.arguments?.[3] || {}
  }
}

// Handles both Command.successEnd and Command.throwError in one plugin.
// addBind restores the caller's store (so user callbacks fire in the right
// async context); addSub finishes the span and tags errors.
class CommandCompletionPlugin extends DatabasePlugin {
  static id = 'mariadb'
  static system = 'mariadb'
  static operation = 'query'

  constructor () {
    super(...arguments)
    const SUCCESS = 'tracing:orchestrion:mariadb:Command_successEnd'
    const THROW = 'tracing:orchestrion:mariadb:Command_throwError'
    this.addDirectBind(`${SUCCESS}:start`, ctx => this.restoreCommandStore(ctx))
    this.addSub(`${SUCCESS}:start`, ctx => this.finishSpan(ctx, false))
    this.addDirectBind(`${THROW}:start`, ctx => this.restoreCommandStore(ctx))
    this.addSub(`${THROW}:start`, ctx => this.finishSpan(ctx, true))
  }

  /**
   * Adds a command-completion store binding that can restore through noop.
   *
   * @param {string} event - Diagnostic channel event name
   * @param {(ctx: object) => object | undefined} transform - Store transform
   * @returns {void}
   */
  addDirectBind (event, transform) {
    this._bindings.push(new DirectStoreBinding(event, transform))
  }

  /**
   * Restores the store for command completion.
   *
   * A command with a Datadog span but no parent store is a root query span; it
   * must complete under an undefined store, not the active noop pool store.
   * Commands without Datadog spans are pool-internal work and should preserve
   * the active store.
   *
   * @param {{ self?: object }} ctx - Orchestrion channel context
   * @returns {object | undefined}
   */
  restoreCommandStore (ctx) {
    const cmd = ctx.self
    if (cmd?.[DD_SPAN]) {
      return cmd[DD_PARENT_STORE]
    }
    return legacyStorage.getStore()
  }

  finishSpan (ctx, isError) {
    const cmd = ctx.self
    if (!cmd) return
    const span = cmd[DD_SPAN]
    if (!span) return
    cmd[DD_SPAN] = undefined
    cmd[DD_PARENT_STORE] = undefined

    if (isError && ctx.arguments?.[0]) {
      this.addError(ctx.arguments[0], span)
    }

    this.tagPeerService(span)
    span.finish()
  }
}

module.exports = [
  MariadbQueryContextPlugin,
  QueryCommandPlugin,
  V2QueryCommandPlugin,
  CommandCompletionPlugin,
]
