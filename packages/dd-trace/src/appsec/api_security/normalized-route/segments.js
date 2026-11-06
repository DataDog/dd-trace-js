'use strict'

/**
 * Build URL segments from either framework's flat tokens, preserving optional slash groups.
 * @template {import('./renderer').RouteToken} T
 * @param {(T | { type: 'slash', group: number })[]} flat
 * @param {Map<number, number>} groupParent
 * @returns {{ segments: { group: number, tokens: T[] }[], groupParent: Map<number, number>, trailingSlash: boolean }}
 */
function segmentsFromTokens (flat, groupParent) {
  /** @type {{ group: number, tokens: T[] }[]} */
  const segments = []
  /** @type {{ group: number, tokens: T[] } | null} */
  let cur = null
  for (const token of flat) {
    if (token.type === 'slash') {
      if (cur) segments.push(cur)
      cur = { group: token.group, tokens: [] }
    } else {
      if (!cur) cur = { group: 0, tokens: [] }
      cur.tokens.push(token)
    }
  }
  if (cur) segments.push(cur)

  let trailingSlash = false
  const last = segments.at(-1)
  if (last && last.tokens.length === 0 && last.group === 0) {
    trailingSlash = true
    segments.pop()
  }

  return { segments, groupParent, trailingSlash }
}

module.exports = { segmentsFromTokens }
