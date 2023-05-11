'use strict'

const iastLog = require('../../../iast-log')

const COMMAND_PATTERN = '^(?:\\s*(?:sudo|doas)\\s+)?\\b\\S+\\b\\s(.*)'

class CommandSensitiveAnalyzer {
  constructor () {
    this._pattern = new RegExp(COMMAND_PATTERN, 'gmi')
  }

  extractSensitiveRanges (evidence) {
    try {
      this._pattern.lastIndex = 0

      const regexResult = this._pattern.exec(evidence.value)
      if (regexResult && regexResult.length > 1) {
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

module.exports = CommandSensitiveAnalyzer
