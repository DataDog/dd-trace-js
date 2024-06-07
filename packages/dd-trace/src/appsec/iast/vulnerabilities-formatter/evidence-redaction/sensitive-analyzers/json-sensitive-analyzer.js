'use strict'

const { stringifyWithRanges } = require('../../utils')

module.exports = function extractSensitiveRanges (evidence) {
  // expect object evidence
  const { value, ranges, sensitiveRanges } = stringifyWithRanges(evidence.value, evidence.rangesToApply, true)
  evidence.value = value
  evidence.ranges = ranges

  return sensitiveRanges
}
