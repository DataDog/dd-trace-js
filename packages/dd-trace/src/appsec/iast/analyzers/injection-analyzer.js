'use strict'
const Analyzer = require('./vulnerability-analyzer')
const { isTainted, getRanges } = require('../taint-tracking/operations')
const { SQL_ROW_VALUE } = require('../taint-tracking/source-types')

class InjectionAnalyzer extends Analyzer {
  _isVulnerable (value, iastContext) {
    if (value) {
      if (!isTainted(iastContext, value)) {
        return false
      }

      return this._areRangesVulnerable(getRanges(iastContext, value))
    }

    return false
  }

  _getEvidence (value, iastContext) {
    const ranges = getRanges(iastContext, value)
    return { value, ranges }
  }

  _areRangesVulnerable (ranges) {
    if (!ranges) return false

    const nonRowRanges = ranges.filter(range => range.iinfo.type !== SQL_ROW_VALUE)

    return nonRowRanges.length > 0
  }
}

module.exports = InjectionAnalyzer
