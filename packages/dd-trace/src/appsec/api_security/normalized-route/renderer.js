'use strict'

/**
 * @typedef {{ type: 'static', text: string, group: number }
 *   | { type: 'param' | 'wildcard', name?: string, group: number }} RouteToken
 * @typedef {{ group: number, tokens: RouteToken[] }} RouteSegment
 * @typedef {{ segments: RouteSegment[], groupParent: Map<number, number> }} RouteTemplate
 */

/**
 * Build URL segments from either framework's flat tokens, preserving optional slash groups.
 * @param {(RouteToken | { type: 'slash', group: number })[]} flat
 * @param {Map<number, number>} groupParent
 * @returns {RouteTemplate}
 */
function segmentsFromTokens (flat, groupParent) {
  /** @type {RouteSegment[]} */
  const segments = []
  /** @type {RouteSegment | undefined} */
  let current
  for (const token of flat) {
    if (token.type === 'slash') {
      if (current) segments.push(current)
      current = { group: token.group, tokens: [] }
    } else {
      current ??= { group: 0, tokens: [] }
      current.tokens.push(token)
    }
  }
  if (current) segments.push(current)
  return { segments, groupParent }
}

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
 * URL-encode chars outside the static alphabet [A-Za-z0-9.-~_], keeping valid %XX escapes. The 'u' flag iterates whole
 * codepoints so surrogate pairs encode as correct multi-byte UTF-8.
 * @param {string} str
 */
function encodeStaticSegment (str) {
  return str.replaceAll(/%[0-9A-Fa-f]{2}|[^A-Za-z0-9.\-~_]/gu, c => {
    if (c.length === 3) return c.toUpperCase()
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

  // Valid supplied names keep their last occurrence, whose value the framework exposes.
  // Reserve them before assigning names to sanitized, duplicate and unnamed parameters.
  const sanitized = dyn.map(t => t.name?.replaceAll(/[^A-Za-z0-9_]/gu, '_'))
  const lastIndexByName = new Map()
  for (let idx = 0; idx < dyn.length; idx++) {
    if (sanitized[idx] && sanitized[idx] === dyn[idx].name) lastIndexByName.set(dyn[idx].name, idx)
  }
  const used = new Set(lastIndexByName.keys())
  const resolvedNames = new Array(dyn.length)
  let counter = 1
  for (let idx = 0; idx < dyn.length; idx++) {
    let name = dyn[idx].name
    if (!sanitized[idx]) {
      while (used.has(`param${counter}`)) counter++
      name = `param${counter++}`
      used.add(name)
    } else if (lastIndexByName.get(name) !== idx) {
      name = sanitized[idx]
      for (let n = 2; used.has(name); n++) name = `${sanitized[idx]}_${n}`
      used.add(name)
    }
    resolvedNames[idx] = name
  }

  // Pass 3: build the output elements. Each present leading slash starts a new element; a segment
  // whose leading slash is absent merges its still-present tokens into the current element (so the
  // '.json' in '/x{/:id}.json' survives when :id is absent) rather than being dropped with the slash.
  const out = []
  let dynPtr = 0
  let current = ''
  let trailingSlash = false

  for (const seg of segments) {
    if (groupActive(seg.group, groupParent, present)) {
      out.push(current)
      current = ''
      trailingSlash = true
    }
    for (const t of seg.tokens) {
      if (!groupActive(t.group, groupParent, present)) continue
      current += t.type === 'static' ? encodeStaticSegment(t.text) : `{${resolvedNames[dynPtr++]}}`
      trailingSlash = false
    }
  }
  out.push(current)

  const normalized = '/' + out.filter(Boolean).join('/')
  return trailingSlash && normalized !== '/' ? normalized + '/' : normalized
}

/**
 * True when a param value is missing or empty; a catch-all that captured only slashes is empty.
 * @param {unknown} value - raw string (match) or decoded value (req.params)
 * @param {boolean} wildcard
 */
function isEmptyValue (value, wildcard) {
  if (value === undefined || value === '') return true
  if (!wildcard) return false
  return Array.isArray(value) ? value.every(part => part === '') : /^\/*$/.test(String(value))
}

module.exports = { renderRoute, isEmptyValue, segmentsFromTokens }
