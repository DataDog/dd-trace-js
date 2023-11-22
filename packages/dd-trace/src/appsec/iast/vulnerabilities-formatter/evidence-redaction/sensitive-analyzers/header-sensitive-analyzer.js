'use strict'

const {
  DEFAULT_IAST_REDACTION_NAME_PATTERN,
  DEFAULT_IAST_REDACTION_VALUE_PATTERN
} = require('../sensitive-regex')

const { HEADER_NAME_VALUE_SEPARATOR } = require('../../constants')

module.exports = {
  extractSensitiveRanges (evidence) {
    const evidenceValue = evidence.value
    const sections = evidenceValue.split(HEADER_NAME_VALUE_SEPARATOR)
    const headerName = sections[0]
    const headerValue = sections.slice(1).join(HEADER_NAME_VALUE_SEPARATOR)
    if (headerName.match(DEFAULT_IAST_REDACTION_NAME_PATTERN) ||
      headerValue.match(DEFAULT_IAST_REDACTION_VALUE_PATTERN)) {
      return [{
        start: headerName.length + HEADER_NAME_VALUE_SEPARATOR.length,
        end: evidenceValue.length
      }]
    }

    return []
  }
}

