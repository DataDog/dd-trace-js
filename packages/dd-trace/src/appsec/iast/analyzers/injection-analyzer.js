'use strict'
const Analyzer = require('./vulnerability-analyzer')
const { getRanges } = require('../taint-tracking/operations')
const { SQL_ROW_VALUE } = require('../taint-tracking/source-types')

class InjectionAnalyzer extends Analyzer {
  _isVulnerable (value, iastContext) {
    const ranges = value && getRanges(iastContext, value)
    if (ranges?.length > 0) {
      return this._areRangesVulnerable(ranges)
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
