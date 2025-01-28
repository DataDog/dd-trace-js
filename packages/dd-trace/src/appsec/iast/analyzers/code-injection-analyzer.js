'use strict'

const { CODE_INJECTION } = require('../vulnerabilities')
const StoredInjectionAnalyzer = require('./stored-injection-analyzer')

class CodeInjectionAnalyzer extends StoredInjectionAnalyzer {
  constructor () {
    super(CODE_INJECTION)
  }

  onConfigure () {
    this.addSub('datadog:eval:call', ({ script }) => this.analyze(script))
    this.addSub('datadog:vm:run-script:start', ({ code }) => this.analyze(code))
    this.addSub('datadog:vm:source-text-module:start', ({ code }) => this.analyze(code))
  }
}

module.exports = new CodeInjectionAnalyzer()
