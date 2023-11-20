'use strict'

// const iastLog = require('../../../iast-log')
const {
  DEFAULT_IAST_REDACTION_NAME_PATTERN,
  DEFAULT_IAST_REDACTION_VALUE_PATTERN
} = require('../sensitive-regex')
class HeaderSensitiveAnalyzer {
  extractSensitiveRanges (evidence) {
    if (evidence.context?.headerName.match(DEFAULT_IAST_REDACTION_NAME_PATTERN) ||
      evidence.value.match(DEFAULT_IAST_REDACTION_VALUE_PATTERN)) {
      return [{
        start: 0,
        end: evidence.value.length
      }]
    }

    return []
  }
}

module.exports = HeaderSensitiveAnalyzer
