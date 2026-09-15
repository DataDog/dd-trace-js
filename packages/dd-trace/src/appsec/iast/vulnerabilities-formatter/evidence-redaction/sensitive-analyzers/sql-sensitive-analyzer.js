'use strict'

const log = require('../../../../../log')

// Single-pass scanner for sensitive literals and comments in SQL evidence.
// Well-formed tokens keep their delimiters outside the masked range. Unterminated tokens mask the remaining evidence.
// Multiline Postgres dollar quotes and Oracle alternative quotes include their delimiters in the masked range.

const LINE_FEED = 0x0A
const CARRIAGE_RETURN = 0x0D
const DOUBLE_QUOTE = 0x22
const HASH = 0x23
const DOLLAR = 0x24
const SINGLE_QUOTE = 0x27
const ASTERISK = 0x2A
const PLUS = 0x2B
const MINUS = 0x2D
const DOT = 0x2E
const SLASH = 0x2F
const DIGIT_0 = 0x30
const DIGIT_9 = 0x39
const UPPER_B = 0x42
const UPPER_E = 0x45
const UPPER_Q = 0x51
const UPPER_X = 0x58
const BACKSLASH = 0x5C
const UNDERSCORE = 0x5F
const LOWER_A = 0x61
const LOWER_B = 0x62
const LOWER_E = 0x65
const LOWER_Q = 0x71
const LOWER_X = 0x78
const LOWER_Z = 0x7A
const LINE_SEPARATOR = 0x20_28
const PARAGRAPH_SEPARATOR = 0x20_29

const ASCII_CASE_BIT = 0x20

// Oracle alternative-quote bracket delimiters and their mirrors (by char code); any other char
// closes on itself.
const ORACLE_CLOSERS = new Map([[0x3C, 0x3E], [0x28, 0x29], [0x7B, 0x7D], [0x5B, 0x5D]])

/**
 * @param {number} code
 */
function isLineTerminator (code) {
  return code === LINE_FEED || code === CARRIAGE_RETURN ||
    code === LINE_SEPARATOR || code === PARAGRAPH_SEPARATOR
}

/**
 * Scans a half-open range for SQL line terminators.
 * @param {string} value
 * @param {number} from
 * @param {number} to
 */
function hasLineTerminator (value, from, to) {
  for (let i = from; i < to; i++) {
    if (isLineTerminator(value.charCodeAt(i))) {
      return true
    }
  }
  return false
}

// The sticky (`y`) regex checks only `lastIndex`. It handles signs, exponents, radix literals, and decimals embedded
// in identifiers after `canStartNumber` and `scanPlainNumber` exclude the simpler forms.
const NUMERIC = /[-+]?(?:x'[\da-f]+'|0x[\da-f]+|b'[\da-f]+'|0b[\da-f]+|\d*\.\d+(?:e[-+]?\d+[fd]?)?|\b\d+(?:e[-+]?\d+[fd]?)?)/iy

/**
 * Cheap gate for the numeric regex: a numeric literal can only begin with a sign, a digit, a `.`, or the
 * `x`/`b` radix prefixes — and the latter only when immediately followed by `'` (`x'FF'` / `b'10'`).
 * Everything else (letters, whitespace, punctuation) skips the regex entirely.
 * @param {string} value
 * @param {number} index
 * @param {number} code
 */
function canStartNumber (value, index, code) {
  if ((code >= DIGIT_0 && code <= DIGIT_9) || code === PLUS || code === MINUS || code === DOT) {
    return true
  }
  if (code === LOWER_X || code === UPPER_X || code === LOWER_B || code === UPPER_B) {
    return value.charCodeAt(index + 1) === SINGLE_QUOTE
  }
  return false
}

/**
 * Treats code units outside the value as non-identifier characters.
 * @param {number} code
 */
function isIdentifierChar (code) {
  const folded = code | ASCII_CASE_BIT
  return (code >= DIGIT_0 && code <= DIGIT_9) ||
    (folded >= LOWER_A && folded <= LOWER_Z) ||
    code === UNDERSCORE
}

/**
 * @param {string} value
 * @param {number} from
 * @param {number} length
 */
function digitRunEnd (value, from, length) {
  let end = from
  while (end < length) {
    const code = value.charCodeAt(end)
    if (code < DIGIT_0 || code > DIGIT_9) {
      break
    }
    end++
  }
  return end
}

/**
 * Handles plain integer and decimal literals. Exponents and radix literals defer to `NUMERIC`.
 * @param {string} value
 * @param {number} intEnd Index after the integer digit run measured by the caller.
 * @param {number} length
 * @returns {number} Index after the literal, or `-1` to defer to the `NUMERIC` regex.
 */
function scanPlainNumber (value, intEnd, length) {
  // A digit run touching `x`/`b` is a radix prefix (`0x`, `0b`) — let the regex own it.
  const afterInt = value.charCodeAt(intEnd)
  if (afterInt === LOWER_X || afterInt === UPPER_X || afterInt === LOWER_B || afterInt === UPPER_B) {
    return -1
  }
  if (afterInt === DOT) {
    const fracEnd = digitRunEnd(value, intEnd + 1, length)
    // `\d*\.\d+`: a fractional literal needs at least one digit after the `.`. A trailing `.` with no
    // fraction digits (`3.`) is not part of the number — fall through to the integer-only result below.
    if (fracEnd > intEnd + 1) {
      const afterFrac = value.charCodeAt(fracEnd)
      return afterFrac === LOWER_E || afterFrac === UPPER_E ? -1 : fracEnd
    }
  }
  // `\b\d+`: a pure integer. An `e`/`E` right after it is an exponent the regex must handle.
  return afterInt === LOWER_E || afterInt === UPPER_E ? -1 : intEnd
}

// The next index that could begin a token: a numeric start (sign, digit, a `.` before a digit, or
// `x`/`b`/`q` before a quote), a string/comment delimiter, or a dialect literal opener. Used to skip
// non-token runs (identifiers, keywords, whitespace) in one native scan instead of a per-character loop.
// `.` is gated by `(?=\d)` because the only literal it can begin is `.5`; this keeps `a.b` column access
// — the most common false positive in SQL — out of the scan entirely.
const CANDIDATE_ANSI = /[-+\d'/]|\.(?=\d)|[xXbB](?=')/g
const CANDIDATE_MYSQL = /[-+\d'"/#]|\.(?=\d)|[xXbB](?=')/g
const CANDIDATE_SQLITE = /[-+\d'"/]|\.(?=\d)|[xXbB](?=')/g
const CANDIDATE_POSTGRES = /[-+\d'$/]|\.(?=\d)|[xXbB](?=')/g
const CANDIDATE_ORACLE = /[-+\d'/]|\.(?=\d)|[xXbBqQ](?=')/g

const BACKSLASH_QUOTES = 1 << 0
const CONSERVATIVE_BACKSLASH_QUOTES = 1 << 1
const HASH_COMMENTS = 1 << 2
const POSTGRES_SYNTAX = 1 << 3
const ORACLE_SYNTAX = 1 << 4

const ANSI_POLICY = { candidates: CANDIDATE_ANSI, features: 0 }
const MYSQL_POLICY = {
  candidates: CANDIDATE_MYSQL,
  features: BACKSLASH_QUOTES | HASH_COMMENTS,
}
const DIALECT_POLICIES = new Map([
  ['MYSQL', MYSQL_POLICY],
  ['MARIADB', MYSQL_POLICY],
  ['SQLITE', { candidates: CANDIDATE_SQLITE, features: CONSERVATIVE_BACKSLASH_QUOTES }],
  ['POSTGRES', { candidates: CANDIDATE_POSTGRES, features: POSTGRES_SYNTAX }],
  ['ORACLE', { candidates: CANDIDATE_ORACLE, features: ORACLE_SYNTAX }],
])

// Scanner return sentinels (distinct from any real end index, which is always > start >= 0):
const UNTERMINATED = -1 // literal opened but never closed -> mask raw to the end of the value
const FALL_THROUGH = -2 // not a literal start -> advance one character and reconsider

/**
 * @param {string} value
 * @param {number} from
 * @param {number} length
 * @returns {number} Index of the first line terminator at or after `from`, else `length`.
 */
function lineEnd (value, from, length) {
  for (let i = from; i < length; i++) {
    if (isLineTerminator(value.charCodeAt(i))) {
      return i
    }
  }
  return length
}

/**
 * `'…'` or `"…"` with doubled-quote escaping. Strings may span lines.
 * @param {string} value
 * @param {number} start
 * @param {number} length
 * @param {number} quote Char code of the opening delimiter, `'` or `"`.
 * @param {boolean} conservativeBackslash Whether an odd backslash before a closing quote makes the
 *   remainder ambiguous and therefore unterminated.
 * @returns {number} Index after the closing quote, or `UNTERMINATED`.
 */
function scanQuotedDoubled (value, start, length, quote, conservativeBackslash) {
  let backslashCount = 0
  for (let i = start + 1; i < length; i++) {
    const code = value.charCodeAt(i)
    if (code === BACKSLASH) {
      backslashCount++
      continue
    }
    if (code === quote) {
      if (value.charCodeAt(i + 1) === quote) {
        i++
        backslashCount = 0
        continue
      }
      if (conservativeBackslash && (backslashCount & 1) === 1) {
        return UNTERMINATED
      }
      return i + 1
    }
    backslashCount = 0
  }
  return UNTERMINATED
}

/**
 * `'…'` or `"…"` with backslash escaping (MySQL / MariaDB / Postgres escape strings).
 * @param {string} value
 * @param {number} start
 * @param {number} length
 * @param {number} quote Char code of the opening delimiter, `'` or `"`.
 * @param {boolean} doubled Whether two adjacent quotes escape each other.
 * @returns {number} Index after the closing quote, or `UNTERMINATED`.
 */
function scanQuotedBackslash (value, start, length, quote, doubled) {
  for (let i = start + 1; i < length; i++) {
    const code = value.charCodeAt(i)
    if (code === BACKSLASH) {
      let backslashCount = 1
      while (value.charCodeAt(i + 1) === BACKSLASH) {
        i++
        backslashCount++
      }
      if ((backslashCount & 1) === 1 && value.charCodeAt(i + 1) === quote) {
        i++
      }
      continue
    }
    if (code === quote) {
      if (doubled && value.charCodeAt(i + 1) === quote) {
        i++
        continue
      }
      return i + 1
    }
  }
  return UNTERMINATED
}

/**
 * @param {string} value
 * @param {number} quoteIndex
 */
function isPostgresEscapeString (value, quoteIndex) {
  const prefix = value.charCodeAt(quoteIndex - 1)
  return (prefix === LOWER_E || prefix === UPPER_E) &&
    !isPostgresIdentifierContinuation(value.charCodeAt(quoteIndex - 2))
}

/**
 * Oracle `q'X…X'`: `X` is one of `< ( { [` (closed by its mirror) or any other char (closed by
 * itself). The body may span line terminators.
 * @param {string} value
 * @param {number} start
 * @param {number} length
 * @returns {number} Index after the closing `X'`; `FALL_THROUGH` when `q'` is at the end of the value
 *   or followed by a line terminator — Oracle forbids whitespace as the delimiter, so that `'` is a
 *   plain string, not a quote opener; or `UNTERMINATED`.
 */
function scanOracleQuote (value, start, length) {
  const delimiter = value.charCodeAt(start + 2)
  if (Number.isNaN(delimiter) || isLineTerminator(delimiter)) {
    return FALL_THROUGH
  }
  const closer = ORACLE_CLOSERS.get(delimiter) ?? delimiter
  for (let i = start + 3; i < length; i++) {
    if (value.charCodeAt(i) === closer && value.charCodeAt(i + 1) === SINGLE_QUOTE) {
      return i + 2
    }
  }
  return UNTERMINATED
}

/**
 * Postgres `$tag$ … $tag$`, where `tag` is empty or an identifier. The body may span line
 * terminators — PL/pgSQL function bodies routinely do, and treating a newline as the end of the
 * literal would leave the rest of a multi-line body unredacted.
 * @param {string} value
 * @param {number} start
 * @param {number} length
 * @returns {number} Index after the closing tag; `FALL_THROUGH` when no second `$` exists; or
 *   `UNTERMINATED` when the opening tag is malformed or has no close.
 */
function scanDollarQuote (value, start, length) {
  const tagEnd = value.indexOf('$', start + 1)
  if (tagEnd === -1) {
    return FALL_THROUGH
  }
  if (!isDollarQuoteTag(value, start + 1, tagEnd)) {
    return UNTERMINATED
  }
  const tagLength = tagEnd - start + 1 // both bracket `$` included
  // The closing tag must begin with `$`, so hop `$`-to-`$` and only compare a full tag at each one;
  // the body characters between candidates are skipped natively by `indexOf`.
  for (let i = value.indexOf('$', tagEnd + 1); i !== -1 && i <= length - tagLength;
    i = value.indexOf('$', i + 1)) {
    if (matchesTag(value, start, i, tagLength)) {
      return i + tagLength
    }
  }
  return UNTERMINATED
}

/**
 * A dollar-quote tag is empty (`$$`) or an identifier. The caller has already consumed the
 * `$`-then-digit form, so a leading digit cannot reach here.
 * @see https://www.postgresql.org/docs/current/sql-syntax-lexical.html
 * @param {string} value
 * @param {number} from Index of the first character after the opening `$`.
 * @param {number} to Index of the closing `$` of the tag.
 */
function isDollarQuoteTag (value, from, to) {
  for (let i = from; i < to; i++) {
    const code = value.charCodeAt(i)
    if (!isIdentifierChar(code) && code <= 0x7F) {
      return false
    }
  }
  return true
}

/**
 * @param {number} code
 */
function isPostgresIdentifierContinuation (code) {
  return isIdentifierChar(code) || code === DOLLAR || code > 0x7F
}

/**
 * @param {number} code
 */
function isPostgresIdentifierStart (code) {
  const folded = code | ASCII_CASE_BIT
  return (folded >= LOWER_A && folded <= LOWER_Z) || code === UNDERSCORE || code > 0x7F
}

/**
 * @param {string} value
 * @param {number} index Index of a dollar sign after an identifier continuation character.
 * @param {number} from Earliest unconsumed index; a prior dollar quote cannot be part of this identifier.
 */
function isInsidePostgresIdentifier (value, index, from) {
  let start = index
  while (start > from && isPostgresIdentifierContinuation(value.charCodeAt(start - 1))) {
    start--
  }
  return isPostgresIdentifierStart(value.charCodeAt(start))
}

/**
 * @param {string} value
 * @param {number} from
 * @param {number} length
 */
function postgresIdentifierEnd (value, from, length) {
  let end = from
  while (end < length && isPostgresIdentifierContinuation(value.charCodeAt(end))) {
    end++
  }
  return end
}

/**
 * Compares the `tagLength` code units at `at` against the opening tag at `tagStart` in place, so the
 * closing-tag check costs no `slice` allocation and skips re-reading the leading `$`.
 * @param {string} value
 * @param {number} tagStart
 * @param {number} at
 * @param {number} tagLength
 */
function matchesTag (value, tagStart, at, tagLength) {
  for (let offset = 1; offset < tagLength - 1; offset++) {
    if (value.charCodeAt(tagStart + offset) !== value.charCodeAt(at + offset)) {
      return false
    }
  }
  return value.charCodeAt(at + tagLength - 1) === DOLLAR
}

module.exports = function extractSensitiveRanges (evidence) {
  try {
    const value = evidence.value
    const length = value.length
    // Select token candidates and syntax features together so dialect aliases cannot drift.
    const { candidates, features } = DIALECT_POLICIES.get(evidence.dialect) ?? ANSI_POLICY
    // The greedy block comment needs the last `*/`, but most evidence has none — find it lazily on the
    // first `/*` rather than scanning the whole value up front on every call.
    let lastBlockClose = -2
    let postgresIdentifierFloor = 0
    const ranges = []

    let i = 0
    while (i < length) {
      // Jump to the next position that could start a token; skip the non-token run natively.
      candidates.lastIndex = i
      const candidate = candidates.exec(value)
      if (candidate === null) {
        break
      }
      i = candidate.index
      const code = value.charCodeAt(i)

      if (canStartNumber(value, i, code)) {
        // Measure a digit run once. At a word boundary it is a plain number or a prefix that the regex
        // owns. Inside an identifier only the boundary-free decimal form can match; skip every other
        // run whole instead of retrying the remaining suffix from each digit.
        if (code >= DIGIT_0 && code <= DIGIT_9) {
          const intEnd = digitRunEnd(value, i, length)
          if (isIdentifierChar(value.charCodeAt(i - 1))) {
            const afterInt = value.charCodeAt(intEnd)
            const firstFraction = value.charCodeAt(intEnd + 1)
            if (afterInt !== DOT || firstFraction < DIGIT_0 || firstFraction > DIGIT_9) {
              i = intEnd
              continue
            }
          } else {
            const plainEnd = scanPlainNumber(value, intEnd, length)
            if (plainEnd !== -1) {
              ranges.push({ start: i, end: plainEnd })
              i = plainEnd
              continue
            }
          }
        }
        NUMERIC.lastIndex = i
        if (NUMERIC.exec(value) !== null) {
          // A sticky match starts at `i`, so `lastIndex` is the match end. Numbers are masked whole.
          ranges.push({ start: i, end: NUMERIC.lastIndex })
          i = NUMERIC.lastIndex
          continue
        }
      }

      // Dispatch by first character and record how many delimiter characters to trim from the matched token.
      let end = FALL_THROUGH
      let trimStart = 0
      let trimEnd = 0
      if (code === SINGLE_QUOTE) {
        if ((features & BACKSLASH_QUOTES) !== 0) {
          end = scanQuotedBackslash(value, i, length, SINGLE_QUOTE, false)
        } else if ((features & POSTGRES_SYNTAX) !== 0 && isPostgresEscapeString(value, i)) {
          end = scanQuotedBackslash(value, i, length, SINGLE_QUOTE, true)
        } else {
          end = scanQuotedDoubled(
            value,
            i,
            length,
            SINGLE_QUOTE,
            (features & CONSERVATIVE_BACKSLASH_QUOTES) !== 0
          )
        }
        trimStart = 1
        trimEnd = 1
      } else if (code === DOUBLE_QUOTE) {
        end = (features & BACKSLASH_QUOTES) === 0
          ? scanQuotedDoubled(
            value,
            i,
            length,
            DOUBLE_QUOTE,
            (features & CONSERVATIVE_BACKSLASH_QUOTES) !== 0
          )
          : scanQuotedBackslash(value, i, length, DOUBLE_QUOTE, false)
        trimStart = 1
        trimEnd = 1
      } else if (code === DOLLAR && (features & POSTGRES_SYNTAX) !== 0) {
        if (isPostgresIdentifierContinuation(value.charCodeAt(i - 1)) &&
          isInsidePostgresIdentifier(value, i, postgresIdentifierFloor)) {
          // PostgreSQL requires whitespace between an identifier and a dollar-quoted string because
          // `$` is an identifier continuation character.
          i = postgresIdentifierEnd(value, i, length)
          postgresIdentifierFloor = i
          continue
        }
        const parameterEnd = digitRunEnd(value, i + 1, length)
        if (parameterEnd > i + 1) {
          // `$1` is a parameter reference, so the index is syntax rather than data.
          i = parameterEnd
          postgresIdentifierFloor = i
          continue
        }
        end = scanDollarQuote(value, i, length)
        if (end >= 0 && !hasLineTerminator(value, i, end)) {
          // `$tag$ … $tag$`: trim the opening and closing tags unless the body spans a line.
          trimStart = value.indexOf('$', i + 1) - i + 1
          trimEnd = trimStart
        }
      } else if ((code === LOWER_Q || code === UPPER_Q) && (features & ORACLE_SYNTAX) !== 0) {
        end = scanOracleQuote(value, i, length)
        if (end >= 0 && !hasLineTerminator(value, i, end)) {
          trimStart = 3 // q'X
          trimEnd = 2 // X'
        }
      } else if (code === MINUS && value.charCodeAt(i + 1) === MINUS) {
        end = lineEnd(value, i + 2, length)
        trimStart = 2 // --
      } else if (code === HASH && (features & HASH_COMMENTS) !== 0) {
        end = lineEnd(value, i + 1, length)
        trimStart = 1 // #
      } else if (code === SLASH && value.charCodeAt(i + 1) === ASTERISK) {
        if (lastBlockClose === -2) {
          lastBlockClose = value.lastIndexOf('*/')
        }
        end = lastBlockClose >= i + 2 ? lastBlockClose + 2 : UNTERMINATED
        trimStart = 2 // /*
        trimEnd = 2 // */
      }

      if (end === FALL_THROUGH) {
        i++
      } else if (end === UNTERMINATED) {
        // Mask the unterminated literal/comment raw (delimiters included) to the end of the evidence.
        ranges.push({ start: i, end: length })
        break
      } else {
        ranges.push({ start: i + trimStart, end: end - trimEnd })
        i = end
        if (code === DOLLAR && (features & POSTGRES_SYNTAX) !== 0) {
          postgresIdentifierFloor = i
        }
      }
    }

    return ranges
  } catch (e) {
    log.debug('[ASM] Error extracting sensitive ranges', e)
  }
  return []
}
