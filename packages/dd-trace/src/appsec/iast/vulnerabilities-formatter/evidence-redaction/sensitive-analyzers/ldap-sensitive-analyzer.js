'use strict'

const iastLog = require('../../../iast-log')

const LDAP_PATTERN = '\\(.*?(?:~=|=|<=|>=)(?<LITERAL>[^)]+)\\)'

class LdapSensitiveAnalyzer {
  constructor () {
    this._pattern = new RegExp(LDAP_PATTERN, 'gmi')
  }

  extractSensitiveRanges (evidence) {
    try {
      this._pattern.lastIndex = 0
      const tokens = []

      let regexResult = this._pattern.exec(evidence.value)
      while (regexResult != null) {
        if (!regexResult.groups.LITERAL) continue
        // Computing indices manually since NodeJs 12 does not support d flag on regular expressions
        // TODO Get indices from group by adding d flag in regular expression
        const start = regexResult.index + (regexResult[0].length - regexResult.groups.LITERAL.length - 1)
        const end = start + regexResult.groups.LITERAL.length
        tokens.push({ start, end })
        regexResult = this._pattern.exec(evidence.value)
      }
      return tokens
    } catch (e) {
      iastLog.debug(e)
    }
    return []
  }
}

module.exports = LdapSensitiveAnalyzer
