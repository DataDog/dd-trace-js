'use strict'
const InjectionAnalyzer = require('./injection-analyzer')

class CommandInjectionAnalyzer extends InjectionAnalyzer {
  constructor () {
    super('COMMAND_INJECTION')
    this.addSub('datadog:child_process:execution:start', ({ command }) => this.analyze(command))
  }
}

module.exports = new CommandInjectionAnalyzer()
