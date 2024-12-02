'use strict'

const InjectionAnalyzer = require('./injection-analyzer')
const { TEMPLATE_INJECTION } = require('../vulnerabilities')

class TemplateInjectionAnalyzer extends InjectionAnalyzer {
  constructor () {
    super(TEMPLATE_INJECTION)
  }

  onConfigure () {
    this.addSub('datadog:handlebars:compile:start', ({ source }) => this.analyze(source))
    this.addSub('datadog:handlebars:register-partial:start', ({ partial }) => this.analyze(partial))
    this.addSub('datadog:pug:compile:start', ({ source }) => this.analyze(source))
  }

  _areRangesVulnerable () {
    return true
  }
}

module.exports = new TemplateInjectionAnalyzer()
