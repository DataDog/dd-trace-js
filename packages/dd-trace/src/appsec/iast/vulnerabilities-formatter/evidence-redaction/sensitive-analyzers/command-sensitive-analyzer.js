'use strict'

const log = require('../../../../../log')

const COMMAND_PATTERN = String.raw`^(?:\s*(?:sudo|doas)\s+)?\b\S+\b\s(.*)`
const pattern = new RegExp(COMMAND_PATTERN, 'gmi')

module.exports = function extractSensitiveRanges (evidence) {
  try {
    pattern.lastIndex = 0

    const regexResult = pattern.exec(evidence.value)
    if (regexResult && regexResult.length > 1) {
      const start = regexResult.index + (regexResult[0].length - regexResult[1].length)
      const end = start + regexResult[1].length
      return [{ start, end }]
    }
  } catch (e) {
    log.debug('[ASM] Error extracting sensitive ranges', e)
  }
  return []
}
