'use strict'

module.exports = function extractSensitiveRanges (evidence, valuePattern) {
  const evidenceValue = evidence.value
  valuePattern.lastIndex = 0
  if (valuePattern.test(evidenceValue)) {
    return [{
      start: 0,
      end: evidenceValue.length
    }]
  }

  return []
}
