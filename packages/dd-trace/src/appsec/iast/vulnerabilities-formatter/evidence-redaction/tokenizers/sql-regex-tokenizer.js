'use strict'

const iastLog = require('../../../iast-log')

const STRING_LITERAL = /'(?:''|[^'])*'/
const POSTGRESQL_ESCAPED_LITERAL = /\$([^$]*)\$.*?\$\1\$/
const MYSQL_STRING_LITERAL = /\"(?:\\\"|[^\"])*\"|'(?:\\'|[^'])*'/
const LINE_COMMENT = /--.*$/
const BLOCK_COMMENT = /\/\*[\s\S]*\*\//
const EXPONENT = /(?:E[-+]?\d+[fd]?)?/
const INTEGER_NUMBER = /(?<!\w)\d+/
const DECIMAL_NUMBER = /\d*\.\d+/
const HEX_NUMBER = /x'[0-9a-f]+'|0x[0-9a-f]+/
const BIN_NUMBER = /b'[0-9a-f]+'|0b[0-9a-f]+/
const NUMERIC_LITERAL = new RegExp(
  `[-+]?(?:${
    [
      HEX_NUMBER.source,
      BIN_NUMBER.source,
      DECIMAL_NUMBER.source + EXPONENT.source,
      INTEGER_NUMBER.source + EXPONENT.source
    ].join('|')
  })`
)

const patterns = {
  MYSQL: [
    NUMERIC_LITERAL,
    MYSQL_STRING_LITERAL,
    LINE_COMMENT,
    BLOCK_COMMENT
  ],
  POSTGRES: [
    NUMERIC_LITERAL,
    POSTGRESQL_ESCAPED_LITERAL,
    STRING_LITERAL,
    LINE_COMMENT,
    BLOCK_COMMENT
  ]
}

class SqlRegexTokenizer {
  getPattern (dialect) {
    return new RegExp(patterns[dialect].map(p => p.source).join('|'), 'gmid')
  }

  tokenize (evidence) {
    try {
      const pattern = this.getPattern(evidence.dialect)
      const tokens = []
      let regexResult = pattern.exec(evidence.value)
      while (regexResult != null) {
        const { indices } = regexResult
        delete indices.groups

        const matches = indices.filter(i => i).map(i => ({ start: i[0], end: i[1] }))

        let start = matches[0].start
        let end = matches[0].end
        const startChar = evidence.value.charAt(start)
        if (startChar === '\'' || startChar === '"') {
          start++
          end--
        } else if (end > start + 1) {
          const nextChar = evidence.value.charAt(start + 1)
          if (startChar === '/' && nextChar === '*') {
            start += 2
            end -= 2
          } else if (startChar === '-' && startChar === nextChar) {
            start += 2
          } else if (startChar.toLowerCase() === 'q' && nextChar === '\'') {
            start += 3
            end -= 2
          } else if (startChar === '$') {
            const match = matches.group()
            const size = match.indexOf('$', 1) + 1
            if (size > 1) {
              start += size
              end -= size
            }
          }
        }

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

module.exports = SqlRegexTokenizer
