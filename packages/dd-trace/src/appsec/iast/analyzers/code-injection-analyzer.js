'use strict'

const InjectionAnalyzer = require('./injection-analyzer')
const { CODE_INJECTION } = require('../vulnerabilities')

class CodeInjectionAnalyzer extends InjectionAnalyzer {
  constructor () {
    super(CODE_INJECTION)
  }

  onConfigure () {
    this.addSub('datadog:eval:call', ({ script }) => this.analyze(script))
    this.addSub('datadog:vm:run-script:start', ({ code }) => this.analyze(code))
    this.addSub('datadog:vm:source-text-module:start', ({ sourceText }) => this.analyze(sourceText))
  }

  _areRangesVulnerable () {
    return true
  }
}

module.exports = new CodeInjectionAnalyzer()
