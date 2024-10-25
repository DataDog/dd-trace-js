'use strict'

const InjectionAnalyzer = require('./injection-analyzer')
const { TEMPLATE_INJECTION } = require('../vulnerabilities')

class TemplateInjectionAnalyzer extends InjectionAnalyzer {
  constructor () {
    super(TEMPLATE_INJECTION)
  }

  onConfigure () {
    this.addSub('datadog:handlebars:compile:start', ({ source }) => this.analyze(source))
  }
}

module.exports = new TemplateInjectionAnalyzer()
