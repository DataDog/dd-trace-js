'use strict'
const Analyzer = require('./vulnerability-analyzer')
const { getRanges } = require('../taint-tracking/operations')
const { SQL_ROW_VALUE } = require('../taint-tracking/source-types')

class InjectionAnalyzer extends Analyzer {
  _isVulnerable (value, iastContext) {
    let ranges = value && getRanges(iastContext, value)
    if (ranges?.length > 0) {
      ranges = this._filterSecureRanges(ranges)
      if (!ranges?.length) {
        this._incrementSuppressedMetric(iastContext)
      }

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

  _filterSecureRanges (ranges) {
    return ranges?.filter(range => !this._isRangeSecure(range))
  }

  _isRangeSecure (range) {
    const { secureMarks } = range
    return (secureMarks & this._secureMark) === this._secureMark
  }
}

module.exports = InjectionAnalyzer
