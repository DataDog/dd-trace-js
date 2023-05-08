'use strict'

const iastLog = require('../../../iast-log')

const COMMAND_PATTERN = '^(?:\\s*(?:sudo|doas)\\s+)?\\b\\S+\\b(.*)'

class CommandRegexTokenizer {
  getPattern () {
    return new RegExp(COMMAND_PATTERN, 'gmid')
  }

  tokenize (evidence) {
    try {
      const pattern = this.getPattern()
      const { indices } = pattern.exec(evidence.value)
      delete indices.groups
      if (indices.length > 1) {
        const start = indices[1][0]
        const end = indices[1][1]
        return [{ start, end }]
      }
    } catch (e) {
      iastLog.debug(e)
    }
    return []
  }
}

module.exports = CommandRegexTokenizer
