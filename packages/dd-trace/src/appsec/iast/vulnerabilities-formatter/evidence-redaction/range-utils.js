'use strict'

function contains (rangeContainer, rangeContained) {
  if (rangeContainer.start > rangeContained.start) {
    return false
  }
  return rangeContainer.end >= rangeContained.end
}

function intersects (rangeA, rangeB) {
  return rangeB.start < rangeA.end && rangeB.end > rangeA.start
}

function remove (range, rangeToRemove) {
  if (!intersects(range, rangeToRemove)) {
    return [range]
  } else if (contains(rangeToRemove, range)) {
    return []
  } else {
    const result = []
    if (rangeToRemove.start > range.start) {
      const offset = rangeToRemove.start - range.start
      result.push({ start: range.start, end: range.start + offset })
    }
    if (rangeToRemove.end < range.end) {
      const offset = range.end - rangeToRemove.end
      result.push({ start: rangeToRemove.end, end: rangeToRemove.end + offset })
    }
    return result
  }
}

module.exports = {
  contains,
  intersects,
  remove
}
