'use strict'

function getWebSpan (traces) {
  for (const trace of traces) {
    for (const span of trace) {
      if (span.type === 'web') {
        return span
      }
    }
  }

  throw new Error('web span not found')
}

function createDeepObject (sheetValue, currentLevel = 1, max = 20) {
  if (currentLevel === max) {
    return {
      [`s-${currentLevel}`]: `s-${currentLevel}`,
      [`o-${currentLevel}`]: sheetValue
    }
  }

  return {
    [`s-${currentLevel}`]: `s-${currentLevel}`,
    [`o-${currentLevel}`]: createDeepObject(sheetValue, currentLevel + 1, max)
  }
}

module.exports = {
  getWebSpan,
  createDeepObject
}
