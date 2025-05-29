'use strict'

const log = require('../../../../../log')

const STRING_LITERAL = '\'(?:\'\'|[^\'])*\''
const POSTGRESQL_ESCAPED_LITERAL = String.raw`\$([^$]*)\$.*?\$\1\$`
const MYSQL_STRING_LITERAL = String.raw`"(?:\\"|[^"])*"|'(?:\\'|[^'])*'`
const LINE_COMMENT = '--.*$'
const BLOCK_COMMENT = String.raw`/\*[\s\S]*\*/`
const EXPONENT = String.raw`(?:E[-+]?\d+[fd]?)?`
const INTEGER_NUMBER = String.raw`(?<!\w)\d+`
const DECIMAL_NUMBER = String.raw`\d*\.\d+`
const HEX_NUMBER = 'x\'[0-9a-f]+\'|0x[0-9a-f]+'
const BIN_NUMBER = 'b\'[0-9a-f]+\'|0b[0-9a-f]+'
const NUMERIC_LITERAL =
  `[-+]?(?:${
    [
      HEX_NUMBER,
      BIN_NUMBER,
      DECIMAL_NUMBER + EXPONENT,
      INTEGER_NUMBER + EXPONENT
    ].join('|')
  })`
const ORACLE_ESCAPED_LITERAL = String.raw`q'<.*?>'|q'\(.*?\)'|q'\{.*?\}'|q'\[.*?\]'|q'(?<ESCAPE>.).*?\k<ESCAPE>'`

const patterns = {
  ANSI: new RegExp( // Default
    [
      NUMERIC_LITERAL,
      STRING_LITERAL,
      LINE_COMMENT,
      BLOCK_COMMENT
    ].join('|'),
    'gmi'
  ),
  MYSQL: new RegExp(
    [
      NUMERIC_LITERAL,
      MYSQL_STRING_LITERAL,
      LINE_COMMENT,
      BLOCK_COMMENT
    ].join('|'),
    'gmi'
  ),
  POSTGRES: new RegExp(
    [
      NUMERIC_LITERAL,
      POSTGRESQL_ESCAPED_LITERAL,
      STRING_LITERAL,
      LINE_COMMENT,
      BLOCK_COMMENT
    ].join('|'),
    'gmi'
  ),
  ORACLE: new RegExp([
    NUMERIC_LITERAL,
    ORACLE_ESCAPED_LITERAL,
    STRING_LITERAL,
    LINE_COMMENT,
    BLOCK_COMMENT
  ].join('|'),
  'gmi')
}
patterns.SQLITE = patterns.MYSQL
patterns.MARIADB = patterns.MYSQL

module.exports = function extractSensitiveRanges (evidence) {
  try {
    let pattern = patterns[evidence.dialect]
    if (!pattern) {
      pattern = patterns.ANSI
    }
    pattern.lastIndex = 0
    const tokens = []

    let regexResult = pattern.exec(evidence.value)
    while (regexResult != null) {
      let start = regexResult.index
      let end = regexResult.index + regexResult[0].length
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
          const match = regexResult[0]
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
    log.debug('[ASM] Error extracting sensitive ranges', e)
  }
  return []
}
