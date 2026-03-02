'use strict'

const { UNTRUSTED_DESERIALIZATION } = require('../vulnerabilities')
const InjectionAnalyzer = require('./injection-analyzer')

class UntrustedDeserializationAnalyzer extends InjectionAnalyzer {
  constructor () {
    super(UNTRUSTED_DESERIALIZATION)
  }

  onConfigure () {
    this.addSub('datadog:node-serialize:unserialize:start', ({ obj }) => this.analyze(obj))
  }
}

module.exports = new UntrustedDeserializationAnalyzer()
