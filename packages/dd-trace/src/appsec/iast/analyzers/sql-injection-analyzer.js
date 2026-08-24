'use strict'

const { SQL_INJECTION } = require('../vulnerabilities')
const { getRanges } = require('../taint-tracking/operations')
const { storage } = require('../../../../../datadog-core')
const { getEventSourceRegistry } = require('../../../events/source-registry')
const { getNodeModulesPaths } = require('../path-line')
const StoredInjectionAnalyzer = require('./stored-injection-analyzer')

const DATABASE_QUERY_OPERATION = 'db.query'
const DATABASE_SQL_DIALECTS = {
  mariadb: 'MYSQL',
}
const EXCLUDED_PATHS = getNodeModulesPaths('mariadb', 'mysql', 'mysql2', 'sequelize', 'pg-pool', 'knex')
const SQL_INJECTION_CONTRIBUTOR_ID = 'iast.sql-injection'
const SQL_INJECTION_SOURCES = new Set(['mariadb'])

class SqlInjectionAnalyzer extends StoredInjectionAnalyzer {
  #databaseContributor
  #sourceRegistry

  constructor () {
    super(SQL_INJECTION)

    this.#sourceRegistry = getEventSourceRegistry()
    this.#databaseContributor = Object.freeze({
      sources: SQL_INJECTION_SOURCES,
      start: (event, store) => this.#analyzeDatabaseQuery(event, store),
    })
  }

  /**
   * Enable or disable raw-channel subscriptions and the shared database contributor together.
   *
   * @param {boolean | Record<string, unknown> & {enabled: boolean}} config IAST analyzer configuration.
   * @returns {void}
   */
  configure (config) {
    const enabled = config !== null && typeof config === 'object' ? config.enabled : config

    if (!enabled) {
      this.#sourceRegistry.unregisterContributor(DATABASE_QUERY_OPERATION, SQL_INJECTION_CONTRIBUTOR_ID)
    }
    super.configure(config)
    if (enabled) {
      this.#sourceRegistry.registerContributor(
        DATABASE_QUERY_OPERATION,
        SQL_INJECTION_CONTRIBUTOR_ID,
        this.#databaseContributor
      )
    }
  }

  onConfigure () {
    this.addSub('apm:mysql:query:start', ({ sql }) => this.analyze(sql, undefined, 'MYSQL'))
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

    this.addSub('datadog:mysql:pool:query:start', ({ sql }) => this.setStoreAndAnalyze(sql, 'MYSQL'))
    this.addSub('datadog:mysql:pool:query:finish', () => this.returnToParentStore())

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
   * Analyze one sanitized semantic database query and mark its composed product store.
   *
   * @param {object} event Normalized database query event.
   * @param {object | undefined} store Current IAST request store.
   * @returns {object | undefined} Store preventing duplicate analysis in nested database layers.
   */
  #analyzeDatabaseQuery (event, store) {
    const dialect = DATABASE_SQL_DIALECTS[event.source?.system]
    const statement = event.facts?.statement
    if (!store || !dialect || typeof statement !== 'string') return

    this.analyze(statement, store, dialect)

    return { ...store, sqlAnalyzed: true, sqlParentStore: store }
  }

  setStoreAndAnalyze (query, dialect) {
    const store = this.getStoreAndAnalyze(query, dialect)

    if (store) {
      storage('legacy').enterWith(store)
    }
  }

  getStoreAndAnalyze (query, dialect) {
    const parentStore = storage('legacy').getStore()
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

  _getEvidence (value, iastContext, dialect) {
    const ranges = getRanges(iastContext, value)
    return { value, ranges, dialect }
  }

  analyze (value, store, dialect) {
    store ||= storage('legacy').getStore()
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
