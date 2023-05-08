'use strict'

const iastLog = require('../../../iast-log')

const LDAP_PATTERN = '\\(.*?(?:~=|=|<=|>=)(?<LITERAL>[^)]+)\\)'

class LdapRegexTokenizer {
  getPattern () {
    return new RegExp(LDAP_PATTERN, 'gmid')
  }

  tokenize (evidence) {
    try {
      const result = evidence.value.matchAll(this.getPattern())
      const tokens = []
      for (const match of result) {
        if (!match.indices.groups.LITERAL) continue
        const start = match.indices.groups.LITERAL[0]
        const end = match.indices.groups.LITERAL[1]
        tokens.push({ start, end })
      }
      return tokens
    } catch (e) {
      iastLog.debug(e)
    }
    return []
  }
}

module.exports = LdapRegexTokenizer
