'use strict'

const log = require('../../../../../log')

// `\S+\s` accepts command tokens that end in punctuation. The optional prefix uses horizontal
// whitespace so multiline matching cannot start inside a line-terminator run.
const COMMAND_PATTERN = String.raw`^(?:[ \t]*(?:sudo|doas)[ \t]+)?\S+\s([\s\S]*)`
const pattern = new RegExp(COMMAND_PATTERN, 'gmi')

module.exports = function extractSensitiveRanges (evidence) {
  try {
    pattern.lastIndex = 0

    const regexResult = pattern.exec(evidence.value)
    if (regexResult?.length > 1) {
      const start = regexResult.index + (regexResult[0].length - regexResult[1].length)
      const end = start + regexResult[1].length
      return [{ start, end }]
    }
  } catch (e) {
    log.debug('[ASM] Error extracting sensitive ranges', e)
  }
  return []
}
