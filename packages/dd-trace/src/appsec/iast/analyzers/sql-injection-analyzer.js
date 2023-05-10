'use strict'

const InjectionAnalyzer = require('./injection-analyzer')
const { SQL_INJECTION } = require('../vulnerabilities')
const { getRanges } = require('../taint-tracking/operations')
const { storage } = require('../../../../../datadog-core')
const { getIastContext } = require('../iast-context')
const { createVulnerability, addVulnerability } = require('../vulnerability-reporter')

class SqlInjectionAnalyzer extends InjectionAnalyzer {
  constructor () {
    super(SQL_INJECTION)
    this.addSub('apm:mysql:query:start', ({ sql }) => this.analyze(sql, 'MYSQL'))
    this.addSub('apm:mysql2:query:start', ({ sql }) => this.analyze(sql, 'MYSQL'))
    this.addSub('apm:pg:query:start', ({ query }) => this.analyze(query.text, 'POSTGRES'))
  }

  _getEvidence (value, iastContext, dialect) {
    const ranges = getRanges(iastContext, value)
    return { value, ranges, dialect }
  }

  analyze (value, dialect) {
    const store = storage.getStore()
    const iastContext = getIastContext(store)
    if (store && !iastContext) return
    this._reportIfVulnerable(value, iastContext, dialect)
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
      const vulnerability = createVulnerability(this._type, evidence, spanId, location)
      addVulnerability(context, vulnerability)
    }
  }
}

module.exports = new SqlInjectionAnalyzer()
