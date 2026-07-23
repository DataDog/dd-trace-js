'use strict'

const { storage } = require('../../datadog-core')
const { SemanticLifecycleBridge } = require('../../dd-trace/src/events/bridge')
const {
  channels: databaseChannels,
  DatabaseQueryProcessor,
} = require('../../dd-trace/src/events/database')
const { getEventSourceRegistry } = require('../../dd-trace/src/events/source-registry')
const Plugin = require('../../dd-trace/src/plugins/plugin')

const legacyStorage = storage('legacy')
const sourceRegistry = getEventSourceRegistry()

const CONNECTION_QUERY_PREFIX = 'tracing:orchestrion:mysql:Connection_query'
const POOL_QUERY_PREFIX = 'tracing:orchestrion:mysql:Pool_query'
const POOL_GET_CONNECTION_PREFIX = 'tracing:orchestrion:mysql:Pool_getConnection'

const MYSQL_SOURCE = Object.freeze({
  integration: 'mysql',
  system: 'mysql',
})

const channels = {
  start: databaseChannels.queryStart,
  error: databaseChannels.queryError,
  finish: databaseChannels.queryFinish,
}

const connectionQueryLifecycle = new SemanticLifecycleBridge({
  operation: DatabaseQueryProcessor.eventOperation,
  channels,
  normalize: normalizeConnectionQuery,
  sourceRegistry,
})

const poolQueryLifecycle = new SemanticLifecycleBridge({
  operation: DatabaseQueryProcessor.eventOperation,
  channels,
  normalize: normalizePoolQuery,
  shouldPublishSemantic: () => false,
  sourceRegistry,
})

const mysqlAdapter = Object.freeze({
  normalizeConnectionQuery,
  normalizePoolQuery,
})

/**
 * Translate package-scoped MySQL events into the normalized database lifecycle.
 */
class MysqlSourceAdapter extends Plugin {
  static id = 'mysql'

  constructor () {
    super()

    this.addBind(`${CONNECTION_QUERY_PREFIX}:start`, ctx => this.bindConnectionQuery(ctx))
    this.addSub(`${CONNECTION_QUERY_PREFIX}:end`, ctx => this.endConnectionQuery(ctx))
    this.addSub(`${CONNECTION_QUERY_PREFIX}:error`, ctx => this.errorConnectionQuery(ctx))

    this.addBind(`${POOL_QUERY_PREFIX}:start`, ctx => this.bindPoolQuery(ctx))
    this.addSub(`${POOL_QUERY_PREFIX}:end`, ctx => this.endPoolQuery(ctx))

    this.addBind(`${POOL_GET_CONNECTION_PREFIX}:start`, ctx => this.bindPoolGetConnection(ctx))
    this.addBind(`${POOL_GET_CONNECTION_PREFIX}:asyncStart`, ctx => this.bindPoolGetConnectionAsyncStart(ctx))
  }

  /**
   * Normalize a connection query and enter the composed product and APM store.
   *
   * @param {object} context Orchestrion connection query context.
   * @returns {object|undefined} Store active while MySQL starts the query.
   */
  bindConnectionQuery (context) {
    const query = context.arguments[0]
    const store = connectionQueryLifecycle.start(context)

    if (query.sql) {
      query.sql = context.data.statement
    } else {
      context.arguments[0] = context.data.statement
    }

    return store
  }

  /**
   * Attach semantic completion to the returned MySQL query.
   *
   * @param {object} context Orchestrion connection query context.
   * @returns {void}
   */
  endConnectionQuery (context) {
    const query = context.result
    if (!query) return

    if (query._callback) {
      const callback = query._callback
      query._callback = function (error, result) {
        context.result = result
        if (error) {
          context.error = error
          connectionQueryLifecycle.error(context)
        }
        const store = connectionQueryLifecycle.finish(context)
        const callbackStore = store === undefined ? context.parentStore : store

        return legacyStorage.run(callbackStore, () => callback.apply(this, arguments))
      }
    } else if (typeof query.once === 'function') {
      query.once('end', () => connectionQueryLifecycle.finish(context))
    }
  }

  /**
   * Complete a connection query that threw before returning a query object.
   *
   * @param {object} context Orchestrion connection query context.
   * @returns {void}
   */
  errorConnectionQuery (context) {
    connectionQueryLifecycle.error(context)
    connectionQueryLifecycle.finish(context)
  }

  /**
   * Enter product-contributor context while a pool dispatches its nested query.
   *
   * @param {object} context Orchestrion pool query context.
   * @returns {object|undefined} Store active during pool dispatch.
   */
  bindPoolQuery (context) {
    const store = poolQueryLifecycle.start(context)
    const callbackIndex = context.arguments.length - 1
    const callback = context.arguments[callbackIndex]

    if (typeof callback === 'function') {
      context.arguments[callbackIndex] = function () {
        const callbackStore = poolQueryLifecycle.finish(context)
        return legacyStorage.run(callbackStore, () => callback.apply(this, arguments))
      }
    }

    return store
  }

  /**
   * Attach contributor completion to promise and EventEmitter pool results.
   *
   * @param {object} context Orchestrion pool query context.
   * @returns {void}
   */
  endPoolQuery (context) {
    const result = context.result
    if (!result) return

    if (typeof result.then === 'function') {
      const finish = () => poolQueryLifecycle.finish(context)
      result.then(finish, finish)
    } else if (typeof result.once === 'function') {
      result.once('end', () => poolQueryLifecycle.finish(context))
    }
  }

  /**
   * Capture the caller store before MySQL obtains a pooled connection.
   *
   * @param {object} context Orchestrion getConnection context.
   * @returns {object|undefined} Captured caller store.
   */
  bindPoolGetConnection (context) {
    context.currentStore = legacyStorage.getStore()

    return context.currentStore
  }

  /**
   * Restore the captured caller store around the getConnection callback.
   *
   * @param {object} context Orchestrion getConnection context.
   * @returns {object|undefined} Captured caller store.
   */
  bindPoolGetConnectionAsyncStart (context) {
    return context.currentStore
  }
}

/**
 * Normalize a MySQL connection query in place.
 *
 * @param {object} context Orchestrion connection query context.
 * @returns {object} Normalized database query event.
 */
function normalizeConnectionQuery (context) {
  const query = context.arguments[0]

  context.v = 1
  context.kind = 'database'
  context.operation = 'query'
  context.source = MYSQL_SOURCE
  context.data = {
    scope: 'connection',
    statement: query.sql || query,
    connection: context.self.config,
  }

  return context
}

/**
 * Normalize the outer MySQL pool boundary for product contributors.
 *
 * @param {object} context Orchestrion pool query context.
 * @returns {object} Normalized database query event.
 */
function normalizePoolQuery (context) {
  const query = context.arguments[0]

  context.v = 1
  context.kind = 'database'
  context.operation = 'query'
  context.source = MYSQL_SOURCE
  context.data = {
    scope: 'pool',
    statement: query.sql || query,
  }

  return context
}

const sourceRuntime = sourceRegistry.registerSource({
  operation: DatabaseQueryProcessor.eventOperation,
  source: MYSQL_SOURCE.integration,
  owner: 'datadog-plugin-mysql',
  create: () => new MysqlSourceAdapter(),
})

module.exports = {
  MYSQL_SOURCE,
  MysqlSourceAdapter,
  mysqlAdapter,
  sourceRegistry,
  sourceRuntime,
}
