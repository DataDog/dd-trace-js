'use strict'

const { LRUCache } = require('../../../../../../vendor/dist/lru-cache')

const { renderRoute } = require('./renderer')
const { segmentsFromTokens } = require('./segments')

// Express 5 uses path-to-regexp 8 for parsing and optional-group matching. Static-only
// optional groups are dropped; Express 4 has no compatible parser and produces no tag.
// match() is exponential in the optional-group count, so omit routes above this cap.
const MAX_OPTIONAL_GROUPS = 8

// Bound retention across router lifetimes. Keys are declared routes, never request URLs.
const routeCache = new LRUCache({ max: 4096 })
const EMPTY_SET = new Set()

/**
 * @typedef {{ type: 'slash', group: number }
 *   | { type: 'static', text: string, group: number }
 *   | { type: 'param', name: string, group: number }
 *   | { type: 'wildcard', name: string, group: number }} RouteToken
 *
 * `group` is the id of the innermost enclosing optional `{...}` group (0 = top-level, always present).
 *
 * @typedef {{ group: number, tokens: Exclude<RouteToken, { type: 'slash' }>[] }} RouteSegment
 *
 * @typedef {{ type: 'text', value: string } | { type: 'param', name: string }
 *   | { type: 'wildcard', name: string } | { type: 'group', tokens: PathToRegexpToken[] }} PathToRegexpToken
 *
 * @typedef {{ segments: RouteSegment[], groupParent: Map<number, number>, optionalGroups: number[],
 *   trailingSlash: boolean, precomputed: string | null,
 *   matcher: ((url: string) => object | undefined) | null,
 *   variants?: Map<number, string> }} CompiledRoute
 */

/**
 * Convert path-to-regexp's nested token tree into a flat segment model. Text tokens split on '/'
 * into slash + static tokens; each `{...}` group gets a fresh id (parent tracked in groupParent),
 * its inner tokens inherit it. A trailing empty top-level segment denotes a declared trailing slash.
 * @param {PathToRegexpToken[]} ptTokens
 * @returns {{ segments: RouteSegment[], groupParent: Map<number, number>, trailingSlash: boolean }}
 */
function tokensToSegments (ptTokens) {
  const groupParent = new Map()
  let nextGroupId = 0
  /** @type {RouteToken[]} */
  const flat = []

  const walk = (tokens, group) => {
    for (const token of tokens) {
      if (token.type === 'text') {
        const parts = token.value.split('/')
        for (let i = 0; i < parts.length; i++) {
          if (i > 0) flat.push({ type: 'slash', group })
          if (parts[i]) flat.push({ type: 'static', text: parts[i], group })
        }
      } else if (token.type === 'param') {
        flat.push({ type: 'param', name: token.name, group })
      } else if (token.type === 'wildcard') {
        flat.push({ type: 'wildcard', name: token.name, group })
      } else if (token.type === 'group') {
        nextGroupId++
        const groupId = nextGroupId
        groupParent.set(groupId, group)
        walk(token.tokens, groupId)
      }
    }
  }
  walk(ptTokens, 0)

  return segmentsFromTokens(flat, groupParent)
}

/**
 * Compile a raw route string into a CompiledRoute, or null when unsupported.
 * @param {string} route
 * @param {(pattern: string) => { tokens: PathToRegexpToken[] } | undefined} parse
 * @param {(route: string) => ((url: string) => object | undefined) | undefined} makeMatcher
 * @returns {CompiledRoute | null}
 */
function compileRoute (route, parse, makeMatcher) {
  const parsed = parse(route)
  if (!Array.isArray(parsed?.tokens)) return null

  const { segments, groupParent, trailingSlash } = tokensToSegments(parsed.tokens)

  // Empty segments (a bare optional slash like '/users{/}', or '/a//b') carry no element; drop them.
  const cleaned = segments.filter(s => s.tokens.length > 0)

  if (cleaned.length === 0) {
    return {
      segments: [],
      groupParent: new Map(),
      optionalGroups: [],
      trailingSlash: false,
      precomputed: '/',
      matcher: null,
    }
  }

  // A catch-all must be the last token of the last segment (rule 5, terminal).
  for (let s = 0; s < cleaned.length; s++) {
    const toks = cleaned[s].tokens
    for (let k = 0; k < toks.length; k++) {
      if (toks[k].type === 'wildcard' && (s !== cleaned.length - 1 || k !== toks.length - 1)) return null
    }
  }

  // Collapse structural-only groups ('/a{{/b}}'): reparent each group to its nearest represented one.
  const represented = new Set()
  for (const seg of cleaned) {
    if (seg.group !== 0) represented.add(seg.group)
    for (const t of seg.tokens) if (t.group !== 0) represented.add(t.group)
  }
  const effectiveParent = new Map()
  for (const g of represented) {
    let p = groupParent.get(g)
    while (p !== 0 && p !== undefined && !represented.has(p)) p = groupParent.get(p)
    effectiveParent.set(g, p === undefined ? 0 : p)
  }

  // Group presence is read from match()'s params, so a group is resolvable only via a uniquely named
  // param/wildcard (duplicate names collapse to one key). `paramGroups` = groups holding any param,
  // `detectable` = those we can resolve. Omit the route if a param group is unresolvable (would
  // mis-assign presence); a static-only group has no param, so it renders as absent (dropped).
  const nameCount = new Map()
  for (const seg of cleaned) {
    for (const t of seg.tokens) {
      if (t.type !== 'static') nameCount.set(t.name, (nameCount.get(t.name) ?? 0) + 1)
    }
  }
  const paramGroups = new Set()
  const detectable = new Set()
  for (const seg of cleaned) {
    for (const t of seg.tokens) {
      if (t.type === 'static') continue
      // Resolvable only via a unique param the group holds DIRECTLY: a param in a nested optional
      // subgroup can be absent while this group is present, so it can't prove this group's presence.
      if (t.group !== 0 && nameCount.get(t.name) === 1) detectable.add(t.group)
      for (let g = t.group; g !== 0; g = groupParent.get(g)) paramGroups.add(g)
    }
  }
  for (const g of represented) {
    if (paramGroups.has(g) && !detectable.has(g)) return null
  }

  // Only resolvable (param) groups become variants; static-only groups stay out and render absent.
  const optionalGroups = [...represented].filter(g => detectable.has(g)).sort((a, b) => a - b)

  const compiled = {
    segments: cleaned,
    groupParent: effectiveParent,
    optionalGroups,
    trailingSlash,
    precomputed: null,
    matcher: null,
  }

  // No optional groups → fixed output, computed once (no matcher, so group count is irrelevant here).
  if (optionalGroups.length === 0) {
    compiled.precomputed = renderRoute(compiled, EMPTY_SET)
    return compiled
  }

  // match()'s regexp is exponential in the route's TOTAL optional-group count (static and structural
  // groups included, not just the resolvable ones), so cap that before building the matcher.
  if (groupParent.size > MAX_OPTIONAL_GROUPS) return null

  const matcher = makeMatcher(route)
  if (matcher === undefined) return null
  compiled.matcher = matcher
  compiled.variants = new Map()
  return compiled
}

/**
 * Which optional groups are present, from a captured/params object: an optional group is present iff
 * one of its param tokens has a defined own-property value. Marks ancestor groups present too.
 * @param {CompiledRoute} compiled
 * @param {object | null | undefined} params
 * @returns {Set<number>}
 */
function resolvePresence (compiled, params) {
  const present = new Set()
  if (params == null) return present
  const { segments, groupParent } = compiled
  for (const seg of segments) {
    for (const t of seg.tokens) {
      if (t.group === 0 || t.type === 'static') continue
      if (Object.hasOwn(params, t.name) && params[t.name] !== undefined) {
        let g = t.group
        while (g !== 0 && !present.has(g)) {
          present.add(g)
          g = groupParent.get(g)
        }
      }
    }
  }
  return present
}

/**
 * Stable bitmask key for a present-group set (group ids are small, route-local).
 * @param {number[]} optionalGroups
 * @param {Set<number>} present
 */
function presenceBitmask (optionalGroups, present) {
  let mask = 0
  for (let i = 0; i < optionalGroups.length; i++) {
    if (present.has(optionalGroups[i])) mask |= (1 << i)
  }
  return mask
}

/**
 * Normalize an Express route string. Express 5 only: `parse`/`makeMatcher` are path-to-regexp 8's
 * `parse()` and a `match()` factory; returns null when either is unavailable (Express 4).
 * @param {string|undefined} route - route string (the http.route value)
 * @param {object|null|undefined} params - req.params (fallback when the URL doesn't match)
 * @param {string|undefined} urlPath - request URL (query stripped here)
 * @param {((pattern: string) => { tokens: PathToRegexpToken[] } | undefined) | undefined} parse
 * @param {((route: string) => ((url: string) => object | undefined) | undefined) | undefined} makeMatcher
 * @returns {string|null}
 */
function normalizeRoute (route, params, urlPath, parse, makeMatcher) {
  if (typeof route !== 'string' || !route || typeof parse !== 'function' || typeof makeMatcher !== 'function') {
    return null
  }

  let entry = routeCache.get(route)
  if (entry === undefined) {
    entry = compileRoute(route, parse, makeMatcher)
    routeCache.set(route, entry)
  }
  if (entry === null) return null
  if (entry.precomputed !== null) return entry.precomputed

  // The matched URL is authoritative (handles mergeParams=false sub-routers); fall back to
  // req.params when there is no URL or it doesn't match.
  let matched
  if (urlPath) {
    const qIdx = urlPath.indexOf('?')
    matched = entry.matcher(qIdx === -1 ? urlPath : urlPath.slice(0, qIdx))
  }
  const present = resolvePresence(entry, matched ?? params)

  const mask = presenceBitmask(entry.optionalGroups, present)
  const cached = entry.variants.get(mask)
  if (cached !== undefined) return cached

  const result = renderRoute(entry, present)
  entry.variants.set(mask, result)
  return result
}

module.exports = { normalizeRoute }
