'use strict'

const { channel } = require('dc-polyfill')

const { storage } = require('../../datadog-core')
const { SemanticLifecycleBridge } = require('../../dd-trace/src/events/bridge')
const {
  channels: databaseChannels,
  DatabaseQueryProcessor,
} = require('../../dd-trace/src/events/database')
const { getEventSourceRegistry } = require('../../dd-trace/src/events/source-registry')
const Plugin = require('../../dd-trace/src/plugins/plugin')

const DD_CONF = '__ddConf'
const DD_CALLBACK_STORE = Symbol('dd-mariadb-callback-store')
const DD_POOL_QUERY = Symbol('dd-mariadb-pool-query')
const DD_PUBLIC_QUERY = Symbol('dd-mariadb-public-query')
const DD_QUERY_CONTEXT = Symbol('dd-mariadb-query-context')

const legacyStorage = storage('legacy')
const poolQueryStorage = storage('mariadb-pool-query')
const sourceRegistry = getEventSourceRegistry()

const MARIADB_SOURCE = Object.freeze({
  integration: 'mariadb',
  system: 'mariadb',
})

const channels = {
  start: databaseChannels.queryStart,
  error: databaseChannels.queryError,
  finish: databaseChannels.queryFinish,
}

const commandLifecycle = new SemanticLifecycleBridge({
  operation: DatabaseQueryProcessor.eventOperation,
  channels,
  normalize: normalizeCommandQuery,
  shouldPublishSemantic: context => !context[DD_PUBLIC_QUERY],
  sourceRegistry,
})

const v2PoolLifecycle = new SemanticLifecycleBridge({
  operation: DatabaseQueryProcessor.eventOperation,
  channels,
  normalize: normalizeV2PoolQuery,
  sourceRegistry,
})

const mariadbAdapter = Object.freeze({
  normalizeCommandQuery,
  normalizeV2PoolQuery,
})

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
  'PrepareResultPacket_execute',
]

/**
 * Bind a user callback to its caller store and expose that store to commands.
 *
 * @param {Function} callback User callback.
 * @param {object|undefined} parentStore Caller store.
 * @returns {Function} Context-bound callback.
 */
function createContextBoundCallback (callback, parentStore) {
  function wrappedUserCallback (...callbackArgs) {
    return legacyStorage.run(parentStore, () => callback.apply(this, callbackArgs))
  }

  wrappedUserCallback[DD_CALLBACK_STORE] = parentStore
  return wrappedUserCallback
}

/**
 * Store binding that restores command context through an intentional noop store.
 */
class DirectStoreBinding {
  /**
   * @param {string} event Diagnostic channel event name.
   * @param {(context: object) => object|undefined} transform Store transform.
   * @param {object} [store] Storage namespace to bind.
   */
  constructor (event, transform, store = legacyStorage) {
    this._channel = channel(event)
    this._store = store
    this._transform = transform
  }

  /**
   * Enable this store binding.
   *
   * @returns {void}
   */
  enable () {
    this._channel.bindStore(this._store, this._transform)
  }

  /**
   * Disable this store binding.
   *
   * @returns {void}
   */
  disable () {
    this._channel.unbindStore(this._store)
  }
}

/**
 * Subscription that observes user commands even when pool internals use noop.
 */
class DirectSubscription {
  /**
   * @param {string} event Diagnostic channel event name.
   * @param {(context: object) => void} handler Event handler.
   */
  constructor (event, handler) {
    this._channel = channel(event)
    this._handler = handler
  }

  /**
   * Enable this subscription.
   *
   * @returns {void}
   */
  enable () {
    this._channel.subscribe(this._handler)
  }

  /**
   * Disable this subscription.
   *
   * @returns {void}
   */
  disable () {
    this._channel.unsubscribe(this._handler)
  }
}

/**
 * Translate package-scoped MariaDB events into the normalized database lifecycle.
 */
class MariadbSourceAdapter extends Plugin {
  static id = 'mariadb'

  constructor () {
    super()

    for (const name of USER_FACING_CHANNELS) {
      const prefix = `tracing:orchestrion:mariadb:${name}`
      const wrapCallback = name === 'PoolCallback_query' || name === 'PoolCallback_execute'
      this.addBind(`${prefix}:start`, context => this.bindUserQuery(context, wrapCallback))
      if (name === 'PoolPromise_query' || name === 'PoolPromise_execute') {
        this._bindings.push(new DirectStoreBinding(
          `${prefix}:start`,
          context => this.bindPoolQuery(context),
          poolQueryStorage
        ))
      }
      this.addBind(`${prefix}:asyncStart`, context => this.bindUserQueryAsyncStart(context))
    }

    const v2PoolPrefix = 'tracing:orchestrion:mariadb:v2PoolBase_query'
    this.addBind(`${v2PoolPrefix}:start`, context => this.bindV2PoolQuery(context))
    this.addBind(`${v2PoolPrefix}:asyncStart`, context => this.bindV2PoolQueryAsyncStart(context))
    this.addSub(`${v2PoolPrefix}:error`, context => this.errorV2PoolQuery(context))
    this.addSub(`${v2PoolPrefix}:asyncEnd`, context => this.endV2PoolQuery(context))

    this._subscriptions.push(
      new DirectSubscription(
        'tracing:orchestrion:mariadb:Query_construct:end',
        context => this.startCommand(context, false)
      ),
      new DirectSubscription(
        'tracing:orchestrion:mariadb:Execute_construct:end',
        context => this.startCommand(context, false)
      ),
      new DirectSubscription(
        'tracing:orchestrion:mariadb:v2Query_construct:end',
        context => this.startCommand(context, true)
      ),
      new DirectSubscription(
        'tracing:orchestrion:mariadb:Pool_getConnection:start',
        context => this.correlatePoolRequest(context)
      )
    )

    this.addDirectBind(
      'tracing:orchestrion:mariadb:Command_successEnd:start',
      context => this.finishCommand(context, false)
    )
    this.addDirectBind(
      'tracing:orchestrion:mariadb:Command_throwError:start',
      context => this.finishCommand(context, true)
    )
  }

  /**
   * Capture caller context for user-facing callback and promise APIs.
   *
   * @param {object} context Orchestrion query context.
   * @param {boolean} wrapCallback Whether this API lacks an asyncStart callback phase.
   * @returns {object|undefined} Caller store.
   */
  bindUserQuery (context, wrapCallback = false) {
    context.parentStore = legacyStorage.getStore()
    context.currentStore = context.parentStore

    if (wrapCallback) {
      this.wrapUserCallback(context, context.parentStore)
    }

    return context.parentStore
  }

  /**
   * Preserve caller context for v3 pool callbacks that run after a sync end.
   *
   * @param {object} context Orchestrion query context.
   * @param {object|undefined} parentStore Caller store.
   * @returns {void}
   */
  wrapUserCallback (context, parentStore) {
    const args = context.arguments
    if (!args) return

    for (let index = args.length - 1; index >= 0; index--) {
      const callback = args[index]
      if (typeof callback !== 'function') continue

      args[index] = createContextBoundCallback(callback, parentStore)
      return
    }
  }

  /**
   * Restore caller context around user callback and promise continuations.
   *
   * @param {object} context Orchestrion query context.
   * @returns {object|undefined} Caller store.
   */
  bindUserQueryAsyncStart (context) {
    return context.parentStore
  }

  /**
   * Correlate a promise pool call after pool internals clear legacy storage.
   *
   * @param {object} context Orchestrion query context.
   * @returns {object} Package-local correlation store.
   */
  bindPoolQuery (context) {
    const query = context.arguments?.[0]

    return {
      consumed: false,
      parentStore: context.parentStore ?? legacyStorage.getStore(),
      statement: query?.sql || query,
    }
  }

  /**
   * Carry a pool query token through MariaDB's internal callback resource.
   *
   * @param {object} context Orchestrion getConnection context.
   * @returns {void}
   */
  correlatePoolRequest (context) {
    const correlation = poolQueryStorage.getStore()
    const commandParameters = context.arguments?.[0]

    if (correlation && commandParameters && typeof commandParameters === 'object') {
      commandParameters[DD_POOL_QUERY] = correlation
    }
  }

  /**
   * Start the public v2 pool query before pool internals enter noop.
   *
   * @param {object} context Orchestrion pool query context.
   * @returns {object|undefined} Semantic database operation store.
   */
  bindV2PoolQuery (context) {
    const query = context.arguments[0]
    const store = v2PoolLifecycle.start(context)

    if (query?.sql) {
      query.sql = context.data.statement
    } else {
      context.arguments[0] = context.data.statement
    }

    return { ...store, [DD_PUBLIC_QUERY]: true }
  }

  /**
   * Restore caller context around v2 pool query continuations.
   *
   * @param {object} context Orchestrion pool query context.
   * @returns {object|undefined} Caller store.
   */
  bindV2PoolQueryAsyncStart (context) {
    return context.parentStore
  }

  /**
   * Publish a v2 pool query error without completing it twice.
   *
   * @param {object} context Orchestrion pool query context.
   * @returns {void}
   */
  errorV2PoolQuery (context) {
    v2PoolLifecycle.error(context)
  }

  /**
   * Finish a v2 pool query after callback or promise completion.
   *
   * @param {object} context Orchestrion pool query context.
   * @returns {void}
   */
  endV2PoolQuery (context) {
    v2PoolLifecycle.finish(context)
  }

  /**
   * Start a v2 or v3 command lifecycle after its constructor initializes SQL.
   *
   * @param {object} context Orchestrion command constructor context.
   * @param {boolean} version2 Whether the command uses the v2 constructor shape.
   * @returns {void}
   */
  startCommand (context, version2) {
    const command = context.self
    if (!command) return

    const callback = version2 ? undefined : context.arguments?.[3]?.callback
    const poolQuery = context.arguments?.[3]?.[DD_POOL_QUERY] || poolQueryStorage.getStore()
    let currentStore = legacyStorage.getStore()

    if (poolQuery && !poolQuery.consumed && poolQuery.statement === command.sql) {
      poolQuery.consumed = true
      currentStore = poolQuery.parentStore
    }
    if (callback && Object.hasOwn(callback, DD_CALLBACK_STORE)) {
      currentStore = callback[DD_CALLBACK_STORE]
    }

    context.connection = version2 ? context.arguments?.[3] : command.opts
    context.currentStore = currentStore
    context[DD_PUBLIC_QUERY] = currentStore?.[DD_PUBLIC_QUERY] === true
    legacyStorage.run(currentStore, () => commandLifecycle.start(context))

    command.sql = context.data.statement
    command[DD_QUERY_CONTEXT] = context
  }

  /**
   * Complete a command and return the store used by its user callback.
   *
   * @param {object} context Orchestrion command completion context.
   * @param {boolean} isError Whether the command is completing with an error.
   * @returns {object|undefined} Store restored around command completion.
   */
  finishCommand (context, isError) {
    const command = context.self
    const queryContext = command?.[DD_QUERY_CONTEXT]
    if (!queryContext) return legacyStorage.getStore()

    if (isError) {
      queryContext.error = context.arguments?.[0]
      commandLifecycle.error(queryContext)
    }

    let store = commandLifecycle.finish(queryContext)
    if (store?.noop) store = queryContext.parentStore?.noop ? undefined : queryContext.parentStore
    command[DD_QUERY_CONTEXT] = undefined

    return store
  }

  /**
   * Add a command-completion binding that can restore through noop.
   *
   * @param {string} event Diagnostic channel event name.
   * @param {(context: object) => object|undefined} transform Store transform.
   * @returns {void}
   */
  addDirectBind (event, transform) {
    this._bindings.push(new DirectStoreBinding(event, transform))
  }
}

/**
 * Normalize a v2 or v3 command query in place.
 *
 * @param {object} context Orchestrion command constructor context.
 * @returns {object} Normalized database query event.
 */
function normalizeCommandQuery (context) {
  context.v = 1
  context.kind = 'database'
  context.operation = 'query'
  context.source = MARIADB_SOURCE
  context.data = {
    scope: 'command',
    statement: context.self.sql,
    connection: context.connection || {},
  }

  return context
}

/**
 * Normalize a public v2 pool query in place.
 *
 * @param {object} context Orchestrion pool query context.
 * @returns {object} Normalized database query event.
 */
function normalizeV2PoolQuery (context) {
  const query = context.arguments[0]

  context.v = 1
  context.kind = 'database'
  context.operation = 'query'
  context.source = MARIADB_SOURCE
  context.data = {
    scope: 'pool',
    statement: query?.sql || query,
    connection: context.self?.[DD_CONF] || {},
  }

  return context
}

const sourceRuntime = sourceRegistry.registerSource({
  operation: DatabaseQueryProcessor.eventOperation,
  source: MARIADB_SOURCE.integration,
  owner: 'datadog-plugin-mariadb',
  create: () => new MariadbSourceAdapter(),
})

module.exports = {
  MARIADB_SOURCE,
  MariadbSourceAdapter,
  mariadbAdapter,
  poolQueryStorage,
  sourceRegistry,
  sourceRuntime,
}
