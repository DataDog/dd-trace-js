'use strict'
const Analyzer = require('./vulnerability-analyzer')
const { WEAK_RANDOMNESS } = require('../vulnerabilities')

class WeakRandomnessAnalyzer extends Analyzer {
  constructor () {
    super(WEAK_RANDOMNESS)
  }

  onConfigure () {
    this.addSub('datadog:random:call', ({ fn }) => this.analyze(fn))
  }

  _isVulnerable (fn) {
    return fn === Math.random
  }
}

module.exports = new WeakRandomnessAnalyzer()
