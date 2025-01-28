'use strict'

const { TEMPLATE_INJECTION } = require('../vulnerabilities')
const StoredInjectionAnalyzer = require('./stored-injection-analyzer')

class TemplateInjectionAnalyzer extends StoredInjectionAnalyzer {
  constructor () {
    super(TEMPLATE_INJECTION)
  }

  onConfigure () {
    this.addSub('datadog:handlebars:compile:start', ({ source }) => this.analyze(source))
    this.addSub('datadog:handlebars:register-partial:start', ({ partial }) => this.analyze(partial))
    this.addSub('datadog:pug:compile:start', ({ source }) => this.analyze(source))
  }
}

module.exports = new TemplateInjectionAnalyzer()
