'use strict'
const Analyzer = require('./vulnerability-analyzer')
const { isTainted, getRanges } = require('../taint-tracking/operations')

class InjectionAnalyzer extends Analyzer {
  _isVulnerable (value, iastContext) {
    if (value) {
      return isTainted(iastContext, value)
    }
    return false
  }

  _getEvidence (value, iastContext) {
    const ranges = getRanges(iastContext, value)
    return { value, ranges }
  }
}

module.exports = InjectionAnalyzer
