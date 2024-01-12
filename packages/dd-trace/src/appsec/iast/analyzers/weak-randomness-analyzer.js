'use strict'
const Analyzer = require('./vulnerability-analyzer')
const { WEAK_RANDOMNESS } = require('../vulnerabilities')

class WeakRandomnessAnalyzer extends Analyzer {
  constructor () {
    super(WEAK_RANDOMNESS)
  }

  onConfigure () {
    this.addSub('datadog:random:call', ({ target }) => this.analyze(target))
  }

  _isVulnerable (target) {
    return Object.is(target, global.Math)
  }
}

module.exports = new WeakRandomnessAnalyzer()
