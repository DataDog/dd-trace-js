'use strict'
const InjectionAnalyzer = require('./injection-analyzer')

class CmdInjectionAnalyzer extends InjectionAnalyzer {
  constructor () {
    super('CMD_INJECTION')
    this.addSub('datadog:child_process:execution:start', ({ command }) => this.analyze(command))
  }
}

module.exports = new CmdInjectionAnalyzer()
