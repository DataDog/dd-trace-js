'use strict'
const Analyzer = require('./vulnerability-analyzer')
const { isTainted } = require('../taint-tracking')

class SqlInjectionAnalyzer extends Analyzer {
  constructor () {
    super('SQL_INJECTION')
    this.addSub('apm:mysql:query:start', ({ sql }) => this.analyze(sql))
    this.addSub('apm:mysql2:query:start', ({ sql }) => this.analyze(sql))
    this.addSub('apm:pg:query:start', ({ statement }) => this.analyze(statement))
  }

  _isVulnerable (query, iastContext) {
    if (query) {
      return isTainted(iastContext, query)
    }
    return false
  }
}

module.exports = new SqlInjectionAnalyzer()
