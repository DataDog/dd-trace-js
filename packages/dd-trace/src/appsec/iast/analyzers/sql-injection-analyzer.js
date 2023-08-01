'use strict'

const InjectionAnalyzer = require('./injection-analyzer')
const { SQL_INJECTION } = require('../vulnerabilities')
const { getRanges } = require('../taint-tracking/operations')
const { storage } = require('../../../../../datadog-core')
const { getIastContext } = require('../iast-context')
const { addVulnerability } = require('../vulnerability-reporter')
const { getNodeModulesPaths } = require('../path-line')

const EXCLUDED_PATHS = getNodeModulesPaths('mysql', 'mysql2', 'sequelize', 'pg-pool')

class SqlInjectionAnalyzer extends InjectionAnalyzer {
  constructor () {
    super(SQL_INJECTION)
  }

  onConfigure () {
    this.addSub('apm:mysql:query:start', ({ sql }) => this.analyze(sql, 'MYSQL'))
    this.addSub('apm:mysql2:query:start', ({ sql }) => this.analyze(sql, 'MYSQL'))
    this.addSub('apm:pg:query:start', ({ query }) => this.analyze(query.text, 'POSTGRES'))

    this.addSub(
      'datadog:sequelize:query:start',
      ({ sql, dialect }) => this.getStoreAndAnalyze(sql, dialect.toUpperCase())
    )
    this.addSub('datadog:sequelize:query:finish', this.returnToParentStore)

    this.addSub('datadog:pg:pool:query:start', ({ query }) => this.getStoreAndAnalyze(query.text, 'POSTGRES'))
    this.addSub('datadog:pg:pool:query:finish', this.returnToParentStore)

    this.addSub('datadog:mysql:pool:query:start', ({ sql }) => this.getStoreAndAnalyze(sql, 'MYSQL'))
    this.addSub('datadog:mysql:pool:query:finish', this.returnToParentStore)
  }

  getStoreAndAnalyze (query, dialect) {
    const parentStore = storage.getStore()
    if (parentStore) {
      this.analyze(query, dialect, parentStore)

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

  analyze (value, dialect, store = storage.getStore()) {
    if (!(store && store.sqlAnalyzed)) {
      const iastContext = getIastContext(store)
      if (this._isInvalidContext(store, iastContext)) return
      this._reportIfVulnerable(value, iastContext, dialect)
    }
  }

  _reportIfVulnerable (value, context, dialect) {
    if (this._isVulnerable(value, context) && this._checkOCE(context)) {
      this._report(value, context, dialect)
      return true
    }
    return false
  }

  _report (value, context, dialect) {
    const evidence = this._getEvidence(value, context, dialect)
    const location = this._getLocation()
    if (!this._isExcluded(location)) {
      const spanId = context && context.rootSpan && context.rootSpan.context().toSpanId()
      const vulnerability = this._createVulnerability(this._type, evidence, spanId, location)
      addVulnerability(context, vulnerability)
    }
  }

  _getExcludedPaths () {
    return EXCLUDED_PATHS
  }
}

module.exports = new SqlInjectionAnalyzer()
