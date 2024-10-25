'use strict'
const InjectionAnalyzer = require('./injection-analyzer')
const { COMMAND_INJECTION } = require('../vulnerabilities')

class CommandInjectionAnalyzer extends InjectionAnalyzer {
  constructor () {
    super(COMMAND_INJECTION)
  }

  onConfigure () {
    this.addSub('tracing:datadog:child_process:execution:start', ({ command }) => this.analyze(command))
  }
}

module.exports = new CommandInjectionAnalyzer()
