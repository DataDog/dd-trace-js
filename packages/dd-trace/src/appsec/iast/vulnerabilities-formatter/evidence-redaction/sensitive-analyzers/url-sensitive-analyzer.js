'use strict'

const iastLog = require('../../../iast-log')

const AUTHORITY = '^(?:[^:]+:)?//([^@]+)@'
const QUERY_FRAGMENT = '[?#&]([^=&;]+)=([^?#&]+)'
const pattern = new RegExp([AUTHORITY, QUERY_FRAGMENT].join('|'), 'gmi')

module.exports = function extractSensitiveRanges (evidence) {
  try {
    const ranges = []
    let regexResult = pattern.exec(evidence.value)

    while (regexResult != null) {
      if (typeof regexResult[1] === 'string') {
        // AUTHORITY regex match always ends by group + @
        // it means that the match last chars - 1 are always the group
        const end = regexResult.index + (regexResult[0].length - 1)
        const start = end - regexResult[1].length
        ranges.push({ start, end })
      }

      if (typeof regexResult[3] === 'string') {
        // QUERY_FRAGMENT regex always ends with the group
        // it means that the match last chars are always the group
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
