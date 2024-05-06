'use strict'

module.exports = function extractSensitiveRanges (evidence, valuePattern) {
  const { value } = evidence
  if (valuePattern.test(value)) {
    return [{
      start: 0,
      end: value.length
    }]
  }

  return []
}
