'use strict'
const { getRanges } = require('../taint-tracking/operations')
const { SQL_ROW_VALUE } = require('../taint-tracking/source-types')
const Analyzer = require('./vulnerability-analyzer')

class InjectionAnalyzer extends Analyzer {
  _isVulnerable (value, iastContext) {
    let ranges = value && getRanges(iastContext, value)
    if (ranges?.length > 0) {
      ranges = this.#filterSecureRanges(ranges, value)
      if (!ranges?.length) {
        this._incrementSuppressedMetric(iastContext)
      }

      return this.#areRangesVulnerable(ranges)
    }

    return false
  }

  _getEvidence (value, iastContext) {
    const ranges = getRanges(iastContext, value)
    return { value, ranges }
  }

  #areRangesVulnerable (ranges) {
    return ranges?.some(range => range.iinfo.type !== SQL_ROW_VALUE)
  }

  #filterSecureRanges (ranges, value) {
    return ranges?.filter(range => !this.#isRangeSecure(range, value))
  }

  #isRangeSecure (range, _value) {
    // _value is not necessary in this method, but could be used in overridden methods
    // added here for visibility
    const { secureMarks } = range
    return (secureMarks & this._secureMark) === this._secureMark
  }
}

module.exports = InjectionAnalyzer
