'use strict'

module.exports = function extractSensitiveRanges (evidence) {
  const newRanges = []
  if (evidence.ranges[0].start > 0) {
    newRanges.push({
      start: 0,
      end: evidence.ranges[0].start
    })
  }

  for (let i = 0; i < evidence.ranges.length; i++) {
    const currentRange = evidence.ranges[i]
    const nextRange = evidence.ranges[i + 1]

    const start = currentRange.end
    const end = nextRange?.start || evidence.value.length

    if (start < end) {
      newRanges.push({ start, end })
    }
  }

  return newRanges
}
