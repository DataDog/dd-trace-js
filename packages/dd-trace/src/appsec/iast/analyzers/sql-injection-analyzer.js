'use strict'

const { SQL_INJECTION } = require('../vulnerabilities')
const { getRanges } = require('../taint-tracking/operations')
const { storage } = require('../../../../../datadog-core')
const { getNodeModulesPaths } = require('../path-line')
const StoredInjectionAnalyzer = require('./stored-injection-analyzer')

const EXCLUDED_PATHS = getNodeModulesPaths('mysql', 'mysql2', 'sequelize', 'pg-pool', 'knex')

class SqlInjectionAnalyzer extends StoredInjectionAnalyzer {
  constructor () {
    super(SQL_INJECTION)
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
