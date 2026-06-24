'use strict'

const log = require('../../../../../log')

const AUTHORITY = '^(?:[^:]+:)?//([^@]+)@'
// The key class excludes `?` and `#` so the greedy quantifier is bounded per fragment.
// Query keys cannot legitimately contain those characters (they delimit query/fragment
// boundaries), so excluding them preserves match semantics for valid URLs while keeping
// the regex linear on arbitrary input.
const QUERY_FRAGMENT = '[?#&]([^=&;?#]+)=([^?#&]+)'
// eslint-disable-next-line regexp/no-super-linear-move -- opt-in IAST evidence redaction, off the request hot path.
const pattern = new RegExp([AUTHORITY, QUERY_FRAGMENT].join('|'), 'gm')

module.exports = function extractSensitiveRanges (evidence) {
  try {
    const ranges = []
    let regexResult = pattern.exec(evidence.value)

    while (regexResult != null) {
      if (typeof regexResult[1] === 'string') {
        // AUTHORITY regex match always ends by group + @
        // it means that the match last chars - 1 are always the group
        const end = regexResult.index + (regexResult[0].length - 1)
        const start = end - regexResult[1].length
        ranges.push({ start, end })
      }

      if (typeof regexResult[3] === 'string') {
        // QUERY_FRAGMENT regex always ends with the group
        // it means that the match last chars are always the group
        const end = regexResult.index + regexResult[0].length
        const start = end - regexResult[3].length
        ranges.push({ start, end })
      }

      regexResult = pattern.exec(evidence.value)
    }

    return ranges
  } catch (e) {
    log.debug('[ASM] Error extracting sensitive ranges', e)
  }

  return []
}
