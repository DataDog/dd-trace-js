'use strict'

const InjectionAnalyzer = require('./injection-analyzer')
const { CODE_INJECTION } = require('../vulnerabilities')

class CodeInjectionAnalyzer extends InjectionAnalyzer {
  constructor () {
    super(CODE_INJECTION)
  }

  onConfigure () {
    this.addSub('datadog:eval:call', ({ script }) => {
      return this.analyze(script)
    })
  }
}

module.exports = new CodeInjectionAnalyzer()
