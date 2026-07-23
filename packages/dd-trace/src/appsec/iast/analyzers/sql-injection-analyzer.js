'use strict'

const { SQL_INJECTION } = require('../vulnerabilities')
const { getRanges } = require('../taint-tracking/operations')
const { storage } = require('../../../../../datadog-core')
const { getEventSourceRegistry } = require('../../../events/source-registry')
const { getNodeModulesPaths } = require('../path-line')
const StoredInjectionAnalyzer = require('./stored-injection-analyzer')

const EXCLUDED_PATHS = getNodeModulesPaths('mysql', 'mysql2', 'sequelize', 'pg-pool', 'knex')
const DATABASE_QUERY_OPERATION = 'db.query'
const DATABASE_CONTRIBUTOR_ID = 'iast.sql-injection'

class SqlInjectionAnalyzer extends StoredInjectionAnalyzer {
  constructor () {
    super(SQL_INJECTION)

    this._sourceRegistry = getEventSourceRegistry()
    this._databaseContributor = {
      sources: new Set(['mysql']),
      start: (event, store) => this.analyzeDatabaseQuery(event, store),
      finish: (event, store) => this.finishDatabaseQuery(event, store),
    }
  }

  onConfigure () {
    this._mysqlEventSubscription = this._getAndRegisterSubscription({
      moduleName: 'mysql',
      tag: this._type,
    })
    this.addSub('datadog:mysql2:outerquery:start', ({ sql }) => this.analyze(sql, undefined, 'MYSQL'))
    this.addSub(
      'apm:pg:query:start',
      ({ originalText, query }) => this.analyze(originalText || query.text, undefined, 'POSTGRES')
    )

    this.addBind(
      'datadog:sequelize:query:start',
      ({ sql, dialect }) => this.getStoreAndAnalyze(sql, dialect.toUpperCase())
    )
    this.addSub('datadog:sequelize:query:finish', () => this.returnToParentStore())

    this.addBind('datadog:pg:pool:query:start', ({ query }) => this.getStoreAndAnalyze(query.text, 'POSTGRES'))
    this.addSub('datadog:pg:pool:query:finish', () => this.returnToParentStore())

    this.addBind('datadog:knex:raw:start', (context) => {
      const { sql, dialect: knexDialect } = context
      const dialect = this.normalizeKnexDialect(knexDialect)
      const currentStore = this.getStoreAndAnalyze(sql, dialect)
      context.currentStore = currentStore
      return currentStore
    })

    this.addBind('datadog:knex:raw:subscribes', ({ currentStore }) => currentStore)
    this.addBind('datadog:knex:raw:finish', ({ currentStore }) => currentStore?.sqlParentStore)
  }

  /**
   * Register or remove the analyzer from the shared database event domain.
   *
   * @param {boolean|object} config IAST analyzer configuration.
   * @returns {void}
   */
  configure (config) {
    const enabled = typeof config === 'boolean' ? config : config?.enabled === true

    super.configure(config)
    if (enabled) {
      this._sourceRegistry.registerContributor(
        DATABASE_QUERY_OPERATION,
        DATABASE_CONTRIBUTOR_ID,
        this._databaseContributor
      )
    } else {
      this._sourceRegistry.unregisterContributor(DATABASE_QUERY_OPERATION, DATABASE_CONTRIBUTOR_ID)
    }
  }

  /**
   * Analyze a query and return a store marking nested database calls as handled.
   *
   * @param {unknown} query SQL query value.
   * @param {string} dialect SQL dialect.
   * @param {object|undefined} parentStore Parent operation store.
   * @returns {object|undefined} SQL-analyzed child store.
   */
  getStoreAndAnalyze (query, dialect, parentStore = storage('legacy').getStore()) {
    if (parentStore) {
      this.analyze(query, parentStore, dialect)

      return { ...parentStore, sqlAnalyzed: true, sqlParentStore: parentStore }
    }
  }

  returnToParentStore (store = storage('legacy').getStore()) {
    if (store && store.sqlParentStore) {
      storage('legacy').enterWith(store.sqlParentStore)
    }
  }

  /**
   * Analyze one normalized MySQL event without subscribing to package channels.
   *
   * @param {object} event Normalized database query event.
   * @param {object|undefined} store Current operation store.
   * @returns {object|undefined} Store composed into the source lifecycle.
   */
  analyzeDatabaseQuery (event, store) {
    if (event.source?.integration !== 'mysql' || store?.sqlAnalyzed) return store

    return this._execHandlerAndIncMetric({
      handler: () => {
        if (event.data.scope === 'pool') {
          const analyzedStore = this.getStoreAndAnalyze(event.data.statement, 'MYSQL', store)
          if (analyzedStore) event.iastSqlAnalyzed = true
          return analyzedStore || store
        }

        this.analyze(event.data.statement, store, 'MYSQL')
        return store
      },
      metric: this._mysqlEventSubscription.executedMetric,
      tags: this._mysqlEventSubscription.tags,
    })
  }

  /**
   * Restore the parent store for a pool query analyzed by this contributor.
   *
   * @param {object} event Normalized database query event.
   * @param {object|undefined} store Store returned from the start phase.
   * @returns {object|undefined} Parent operation store.
   */
  finishDatabaseQuery (event, store) {
    if (event.source?.integration !== 'mysql' || !event.iastSqlAnalyzed) return store

    event.iastSqlAnalyzed = false
    return store?.sqlParentStore
  }

  _getEvidence (value, iastContext, dialect) {
    const ranges = getRanges(iastContext, value)
    return { value, ranges, dialect }
  }

  analyze (value, store, dialect) {
    store = store || storage('legacy').getStore()
    if (!(store && store.sqlAnalyzed)) {
      super.analyze(value, store, dialect)
    }
  }

  _getExcludedPaths () {
    return EXCLUDED_PATHS
  }

  normalizeKnexDialect (knexDialect) {
    if (knexDialect === 'postgresql') {
      return 'POSTGRES'
    }

    if (knexDialect === 'sqlite3') {
      return 'SQLITE'
    }

    if (typeof knexDialect === 'string') {
      return knexDialect.toUpperCase()
    }
  }
}

module.exports = new SqlInjectionAnalyzer()
