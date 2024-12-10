'use strict'
const Analyzer = require('./vulnerability-analyzer')
const { isTainted, getRanges } = require('../taint-tracking/operations')
const { SQL_ROW_VALUE } = require('../taint-tracking/source-types')

class InjectionAnalyzer extends Analyzer {
  _isVulnerable (value, iastContext) {
    if (value && isTainted(iastContext, value)) {
      return this._areRangesVulnerable(getRanges(iastContext, value))
    }

    return false
  }

  _getEvidence (value, iastContext) {
    const ranges = getRanges(iastContext, value)
    return { value, ranges }
  }

  _areRangesVulnerable (ranges) {
    return ranges?.some(range => range.iinfo.type !== SQL_ROW_VALUE)
  }
}

module.exports = InjectionAnalyzer
