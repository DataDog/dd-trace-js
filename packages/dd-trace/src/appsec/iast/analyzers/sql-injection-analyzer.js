'use strict'

const InjectionAnalyzer = require('./injection-analyzer')
const { SQL_INJECTION } = require('../vulnerabilities')
const { getRanges } = require('../taint-tracking/operations')
const { storage } = require('../../../../../datadog-core')
const { getNodeModulesPaths } = require('../path-line')

const EXCLUDED_PATHS = getNodeModulesPaths('mysql', 'mysql2', 'sequelize', 'pg-pool', 'knex')

class SqlInjectionAnalyzer extends InjectionAnalyzer {
  constructor () {
    super(SQL_INJECTION)
  }

  onConfigure () {
    this.addSub('apm:mysql:query:start', ({ sql }) => this.analyze(sql, undefined, 'MYSQL'))
    this.addSub('apm:mysql2:query:start', ({ sql }) => this.analyze(sql, undefined, 'MYSQL'))
    this.addSub('apm:pg:query:start', ({ query }) => this.analyze(query.text, undefined, 'POSTGRES'))

    this.addSub(
      'datadog:sequelize:query:start',
      ({ sql, dialect }) => this.getStoreAndAnalyze(sql, dialect.toUpperCase())
    )
    this.addSub('datadog:sequelize:query:finish', () => this.returnToParentStore())

    this.addSub('datadog:pg:pool:query:start', ({ query }) => this.getStoreAndAnalyze(query.text, 'POSTGRES'))
    this.addSub('datadog:pg:pool:query:finish', () => this.returnToParentStore())

    this.addSub('datadog:mysql:pool:query:start', ({ sql }) => this.getStoreAndAnalyze(sql, 'MYSQL'))
    this.addSub('datadog:mysql:pool:query:finish', () => this.returnToParentStore())

    this.addSub('datadog:knex:raw:start', ({ sql, dialect: knexDialect }) => {
      const dialect = this.normalizeKnexDialect(knexDialect)
      this.getStoreAndAnalyze(sql, dialect)
    })
    this.addSub('datadog:knex:raw:finish', () => this.returnToParentStore())
  }

  getStoreAndAnalyze (query, dialect) {
    const parentStore = storage.getStore()
    if (parentStore) {
      this.analyze(query, parentStore, dialect)

      storage.enterWith({ ...parentStore, sqlAnalyzed: true, sqlParentStore: parentStore })
    }
  }

  returnToParentStore () {
    const store = storage.getStore()
    if (store && store.sqlParentStore) {
      storage.enterWith(store.sqlParentStore)
    }
  }

  _getEvidence (value, iastContext, dialect) {
    const ranges = getRanges(iastContext, value)
    return { value, ranges, dialect }
  }

  analyze (value, store, dialect) {
    store = store || storage.getStore()
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
