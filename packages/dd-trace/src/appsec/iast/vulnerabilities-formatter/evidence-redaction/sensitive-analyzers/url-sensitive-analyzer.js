'use strict'

const iastLog = require('../../../iast-log')

const AUTHORITY = '^(?:[^:]+:)?//([^@]+)@'
const QUERY_FRAGMENT = '[?#&]([^=&;]+)=([^?#&]+)'

class UrlSensitiveAnalyzer {
  constructor () {
    this._pattern = new RegExp([AUTHORITY, QUERY_FRAGMENT].join('|'), 'gmi')
  }

  extractSensitiveRanges (evidence) {
    try {
      const pattern = this._pattern

      const ranges = []
      let regexResult = pattern.exec(evidence.value)
      while (regexResult != null) {
        if (typeof regexResult[1] === 'string') {
          const end = regexResult.index + (regexResult[0].length - 1)
          const start = end - regexResult[1].length
          ranges.push({ start, end })
        }
        if (typeof regexResult[3] === 'string') {
          const end = regexResult.index + regexResult[0].length
          const start = end - regexResult[3].length
          ranges.push({ start, end })
        }
        regexResult = pattern.exec(evidence.value)
      }
      return ranges
    } catch (e) {
      iastLog.debug(e)
    }
    return []
  }
}

module.exports = UrlSensitiveAnalyzer
