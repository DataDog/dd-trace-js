'use strict'

const iastLog = require('../../../iast-log')

const LDAP_PATTERN = '\\(.*?(?:~=|=|<=|>=)(?<LITERAL>[^)]+)\\)'

class LdapRegexTokenizer {
  getPattern () {
    return new RegExp(LDAP_PATTERN, 'gmi')
  }

  tokenize (evidence) {
    try {
      const pattern = this.getPattern(evidence.dialect)
      const tokens = []

      let regexResult = pattern.exec(evidence.value)
      while (regexResult != null) {
        if (!regexResult.groups.LITERAL) continue
        const start = regexResult.index + (regexResult[0].length - regexResult.groups.LITERAL.length - 1)
        const end = start + regexResult.groups.LITERAL.length
        tokens.push({ start, end })
        regexResult = pattern.exec(evidence.value)
      }
      return tokens
    } catch (e) {
      iastLog.debug(e)
    }
    return []
  }
}

module.exports = LdapRegexTokenizer
