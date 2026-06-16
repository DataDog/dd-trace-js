'use strict'

const log = require('../../../../../log')

const OPEN_PAREN = 0x28
const CLOSE_PAREN = 0x29
const EQUALS = 0x3D
const TILDE = 0x7E
const LESS = 0x3C
const GREATER = 0x3E

// Linear scanner for LDAP assertion-filter values. For each parenthesised group
// "(attr <op> value)" where <op> is "=", "~=", "<=", or ">=" and no nested
// parenthesis appears before the operator, report the value range [opEnd, ')').
// The cursor only ever moves forward, so total work is O(input length).
module.exports = function extractSensitiveRanges (evidence) {
  try {
    const value = evidence?.value
    const tokens = []
    if (typeof value !== 'string') return tokens

    const length = value.length
    let cursor = 0

    while (cursor < length) {
      const open = value.indexOf('(', cursor)
      if (open === -1) break

      let scan = open + 1
      let opStart = -1
      let opLen = 0

      while (scan < length) {
        const code = value.charCodeAt(scan)
        if (code === OPEN_PAREN || code === CLOSE_PAREN) break
        if (code === EQUALS) {
          opStart = scan
          opLen = 1
          break
        }
        if ((code === TILDE || code === LESS || code === GREATER) &&
            scan + 1 < length && value.charCodeAt(scan + 1) === EQUALS) {
          opStart = scan
          opLen = 2
          break
        }
        scan++
      }

      if (opStart === -1) {
        cursor = open + 1
        continue
      }

      const close = value.indexOf(')', opStart + opLen)
      if (close === -1) break

      const start = opStart + opLen
      if (start < close) {
        tokens.push({ start, end: close })
      }
      cursor = close + 1
    }

    return tokens
  } catch (e) {
    log.debug('[ASM] Error extracting sensitive ranges', e)
  }
  return []
}
