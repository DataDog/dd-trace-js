'use strict'

const { HEADER_NAME_VALUE_SEPARATOR } = require('../../constants')

module.exports = function extractSensitiveRanges (evidence, namePattern, valuePattern) {
  const evidenceValue = evidence.value
  const sections = evidenceValue.split(HEADER_NAME_VALUE_SEPARATOR)
  const headerName = sections[0]
  const headerValue = sections.slice(1).join(HEADER_NAME_VALUE_SEPARATOR)
  namePattern.lastIndex = 0
  valuePattern.lastIndex = 0
  if (namePattern.test(headerName) || valuePattern.test(headerValue)) {
    return [{
      start: headerName.length + HEADER_NAME_VALUE_SEPARATOR.length,
      end: evidenceValue.length
    }]
  }

  return []
}
