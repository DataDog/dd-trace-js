'use strict'

const InjectionAnalyzer = require('./injection-analyzer')
const { CODE_INJECTION } = require('../vulnerabilities')

class CodeInjectionAnalyzer extends InjectionAnalyzer {
  constructor () {
    super(CODE_INJECTION)
  }

  onConfigure () {
    this.addSub('datadog:eval:call', ({ script }) => this.analyze(script))
  }

  _areRangesVulnerable () {
    return true
  }
}

module.exports = new CodeInjectionAnalyzer()
