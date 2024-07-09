'use strict'

const InjectionAnalyzer = require('./injection-analyzer')
const { EVAL_INJECTION } = require('../vulnerabilities')

class EvalInjectionAnalyzer extends InjectionAnalyzer {
  constructor () {
    super(EVAL_INJECTION)
  }

  onConfigure () {
    this.addSub('datadog:eval:start', ({ script }) => this.analyze(script))
  }
}

module.exports = new EvalInjectionAnalyzer()
