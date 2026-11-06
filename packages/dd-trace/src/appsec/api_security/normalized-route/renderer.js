'use strict'

/**
 * @typedef {{ type: 'static', text: string, group: number }
 *   | { type: 'param', name?: string, group: number }
 *   | { type: 'wildcard', name?: string, group: number }} RouteToken
 *
 * 'group' is the enclosing optional group, with 0 always present.
 * Every nonzero group must have an entry in groupParent.
 *
 * @typedef {{ group: number, tokens: RouteToken[] }} RouteSegment
 *
 * @typedef {{ segments: RouteSegment[], groupParent: Map<number, number>,
 *   trailingSlash: boolean }} RouteTemplate
 */

/**
 * True when group `g` (and its whole ancestor chain) is present. Group 0 is always present.
 * @param {number} g
 * @param {Map<number, number>} groupParent
 * @param {Set<number>} present
 */
function groupActive (g, groupParent, present) {
  while (g !== 0) {
    if (!present.has(g)) return false
    g = /** @type {number} */ (groupParent.get(g))
  }
  return true
}

/**
 * URL-encode chars outside the RFC-1103 static alphabet [A-Za-z0-9.-~_]. The 'u' flag iterates whole
 * codepoints so surrogate pairs encode as correct multi-byte UTF-8.
 * @param {string} str
 */
function encodeStaticSegment (str) {
  return str.replaceAll(/[^A-Za-z0-9.\-~_]/gu, c => {
    const code = c.charCodeAt(0)
    if (code < 0x80) return '%' + code.toString(16).toUpperCase().padStart(2, '0')
    try {
      return encodeURIComponent(c)
    } catch {
      return '%EF%BF%BD'
    }
  })
}

/**
 * URL-encode the 6 characters not allowed in a normalized param name (/?#+{}).
 * @param {string} name
 */
function encodeParamName (name) {
  return name.replaceAll(/[/?#+{}]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'))
}

/**
 * Render the normalized route for a given set of present optional groups.
 * @param {RouteTemplate} compiled
 * @param {Set<number>} present
 */
function renderRoute (compiled, present) {
  const { segments, groupParent } = compiled

  // Pass 1: present dynamic tokens (param/wildcard) in declaration order. Activity is per token: a
  // mandatory token can share a segment with an absent optional group (e.g. '.json' in '/x{/:id}.json').
  const dyn = []
  for (const seg of segments) {
    for (const t of seg.tokens) {
      if (t.type !== 'static' && groupActive(t.group, groupParent, present)) dyn.push(t)
    }
  }

  // Pass 2: a token keeps its (encoded) name iff it is the last present occurrence of that name;
  // unnamed parameters and earlier duplicates become paramN (skipping surviving names).
  const encodedNames = new Array(dyn.length)
  const lastIndexByName = new Map()
  for (let idx = 0; idx < dyn.length; idx++) {
    const name = dyn[idx].name
    if (name !== undefined) {
      encodedNames[idx] = encodeParamName(name)
      lastIndexByName.set(encodedNames[idx], idx)
    }
  }
  const used = new Set()
  for (let idx = 0; idx < dyn.length; idx++) {
    if (encodedNames[idx] !== undefined && lastIndexByName.get(encodedNames[idx]) === idx) used.add(encodedNames[idx])
  }
  const resolvedNames = new Array(dyn.length)
  let counter = 1
  for (let idx = 0; idx < dyn.length; idx++) {
    if (encodedNames[idx] !== undefined && lastIndexByName.get(encodedNames[idx]) === idx) {
      resolvedNames[idx] = encodedNames[idx]
    } else {
      while (used.has(`param${counter}`)) counter++
      resolvedNames[idx] = `param${counter}`
      used.add(`param${counter}`)
      counter++
    }
  }

  // Pass 3: build the output elements. Each present leading slash starts a new element; a segment
  // whose leading slash is absent merges its still-present tokens into the current element (so the
  // '.json' in '/x{/:id}.json' survives when :id is absent) rather than being dropped with the slash.
  const out = []
  let dynPtr = 0
  let staticText = ''
  let paramNames = []

  const flush = () => {
    if (paramNames.length > 0) {
      out.push(`{${paramNames.join('+')}}`)
    } else if (staticText !== '') {
      out.push(encodeStaticSegment(staticText))
    }
    staticText = ''
    paramNames = []
  }

  for (const seg of segments) {
    if (groupActive(seg.group, groupParent, present)) flush()
    for (const t of seg.tokens) {
      if (!groupActive(t.group, groupParent, present)) continue
      if (t.type === 'static') {
        staticText += t.text
      } else {
        paramNames.push(resolvedNames[dynPtr++])
      }
    }
  }
  flush()

  const normalized = '/' + out.join('/')
  return compiled.trailingSlash && normalized !== '/' ? normalized + '/' : normalized
}

module.exports = { renderRoute }
