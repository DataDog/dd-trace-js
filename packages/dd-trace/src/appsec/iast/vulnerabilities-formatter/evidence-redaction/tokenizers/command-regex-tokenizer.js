'use strict'

const iastLog = require('../../../iast-log')

const COMMAND_PATTERN = '^(?:\\s*(?:sudo|doas)\\s+)?\\b\\S+\\b(.*)'

class CommandRegexTokenizer {
  getPattern () {
    return new RegExp(COMMAND_PATTERN, 'gmi')
  }

  tokenize (evidence) {
    try {
      const pattern = this.getPattern()

      const regexResult = pattern.exec(evidence.value)
      if (regexResult.length > 1) {
        const start = regexResult.index + (regexResult[0].length - regexResult[1].length)
        const end = start + regexResult[1].length
        return [{ start, end }]
      }
    } catch (e) {
      iastLog.debug(e)
    }
    return []
  }
}

module.exports = CommandRegexTokenizer
