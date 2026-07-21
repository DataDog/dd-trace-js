'use strict'

const { HTTP_ROUTE } = require('../../../../../ext/tags')
const web = require('../../plugins/util/web')
const { getParse, getMatch } = require('../../../../datadog-instrumentations/src/path-to-regexp')

/**
 * Normalize an HTTP route to the RFC-1103 _dd.appsec.normalized_route format.
 *
 * Rules: (1) starts with /, trailing slash only if declared; (2) no empty elements; (3) static
 * segments keep [A-Za-z0-9.-~_], other chars percent-encoded (UTF-8); (4) dynamic params render as
 * {name} (chars /?#+{} encoded, + reserved), shadowed duplicate names become paramN; (5) one URL
 * segment = one element, multiple params combine as {a+b}, a catch-all is a single terminal element;
 * (6) optional param elements are resolved per request against the matched URL.
 *
 * Design: Express 5 / path-to-regexp v8 only. The route is parsed once by path-to-regexp's `parse()`
 * (token tree → segment templates, cached per route string). Per-request presence of optional
 * groups is resolved with path-to-regexp's own `match()` — we do not re-implement matching. Static-
 * only optional groups (no param to capture) are omitted (return null). Express 4 ships 0.x (no
 * `parse()`) → no tag.
 */

// Cap on optional groups per route: keeps the presence bitmask within 32 bits and the per-route
// variant cache at 2^N. Routes beyond this are omitted rather than mis-normalized.
const MAX_OPTIONAL_GROUPS = 12

// Per-route compiled-entry cache, keyed on the raw route string. Bounded by the app's declared
// routes (never attacker URLs), so it retains for the process lifetime.
const routeCache = new Map()

const EMPTY_SET = new Set()

/**
 * @typedef {{ type: 'slash', group: number }
 *   | { type: 'static', text: string, group: number }
 *   | { type: 'param', name: string, group: number }
 *   | { type: 'wildcard', name: string, group: number }} RouteToken
 *
 * `group` is the id of the innermost enclosing optional `{...}` group (0 = top-level, always present).
 *
 * @typedef {{ group: number, tokens: RouteToken[] }} RouteSegment
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

  /** @type {RouteSegment[]} */
  const segments = []
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
  const last = segments[segments.length - 1]
  if (last && last.tokens.length === 0 && last.group === 0) {
    trailingSlash = true
    segments.pop()
  }

  return { segments, groupParent, trailingSlash }
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

  // An optional (non-top-level) empty segment is a slash inside a group ('/users{/}'); the optional
  // slash can't be represented, so omit.
  for (const seg of segments) {
    if (seg.tokens.length === 0 && seg.group !== 0) return null
  }

  const cleaned = segments.filter(s => s.tokens.length > 0)

  // Root "/" (and any all-empty route) → single "/" element.
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

  // A catch-all must be the last token of the last segment (rule 5, terminal). Anything after it
  // ('/files/*p.:ext', '/*a/*b', '/*a/edit') can't be one atomic element.
  for (let s = 0; s < cleaned.length; s++) {
    const toks = cleaned[s].tokens
    for (let k = 0; k < toks.length; k++) {
      if (toks[k].type === 'wildcard' && (s !== cleaned.length - 1 || k !== toks.length - 1)) return null
    }
  }

  // Collapse structural-only groups ('/a{{/b}}'): reparent each represented group to its nearest
  // represented ancestor.
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

  // Presence comes from path-to-regexp's captured params. A duplicate param name collapses to one
  // key in match()'s output, so it can't tell which occurrence a request filled — only a uniquely
  // named param/wildcard can prove its group present. Mark every group on such a token's ancestor
  // chain detectable, then reject any optional group that isn't (static-only, or shadowed-name).
  const nameCount = new Map()
  for (const seg of cleaned) {
    for (const t of seg.tokens) {
      if (t.type !== 'static') nameCount.set(t.name, (nameCount.get(t.name) ?? 0) + 1)
    }
  }
  const detectable = new Set()
  for (const seg of cleaned) {
    for (const t of seg.tokens) {
      if (t.type === 'static' || nameCount.get(t.name) !== 1) continue
      let g = t.group
      while (g !== 0 && !detectable.has(g)) {
        detectable.add(g)
        g = groupParent.get(g)
      }
    }
  }
  for (const g of represented) {
    if (!detectable.has(g)) return null
  }

  const optionalGroups = [...represented].sort((a, b) => a - b)
  if (optionalGroups.length > MAX_OPTIONAL_GROUPS) return null

  const compiled = {
    segments: cleaned,
    groupParent: effectiveParent,
    optionalGroups,
    trailingSlash,
    precomputed: null,
    matcher: null,
  }

  // No optional groups → fixed output, computed once.
  if (optionalGroups.length === 0) {
    compiled.precomputed = renderRoute(compiled, EMPTY_SET)
    return compiled
  }

  // Otherwise resolve presence per request with path-to-regexp's own matcher (built once here).
  const matcher = makeMatcher(route)
  if (matcher === undefined) return null
  compiled.matcher = matcher
  return compiled
}

/**
 * True when group `g` (and its whole ancestor chain) is present. Group 0 is always present.
 * @param {number} g
 * @param {Map<number, number>} groupParent
 * @param {Set<number>} present
 * @returns {boolean}
 */
function groupActive (g, groupParent, present) {
  while (g !== 0) {
    if (!present.has(g)) return false
    g = groupParent.get(g)
  }
  return true
}

/**
 * URL-encode chars outside the RFC-1103 static alphabet [A-Za-z0-9.-~_]. The 'u' flag iterates whole
 * codepoints so surrogate pairs encode as correct multi-byte UTF-8.
 * @param {string} str
 * @returns {string}
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
 * @returns {string}
 */
function encodeParamName (name) {
  return name.replaceAll(/[/?#+{}]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'))
}

/**
 * Render the normalized route for a given set of present optional groups.
 * @param {CompiledRoute} compiled
 * @param {Set<number>} present
 * @returns {string}
 */
function renderRoute (compiled, present) {
  const { segments, groupParent } = compiled

  // Pass 1: present dynamic tokens (param/wildcard) in declaration order.
  const dyn = []
  for (const seg of segments) {
    if (!groupActive(seg.group, groupParent, present)) continue
    for (const t of seg.tokens) {
      if (t.type !== 'static' && groupActive(t.group, groupParent, present)) dyn.push(t)
    }
  }

  // Pass 2: resolve names on their ENCODED form. A token keeps its name iff it is the last present
  // occurrence of that encoded name; earlier duplicates become paramN (skipping surviving names).
  const encodedNames = new Array(dyn.length)
  const lastIndexByName = new Map()
  for (let idx = 0; idx < dyn.length; idx++) {
    encodedNames[idx] = encodeParamName(dyn[idx].name)
    lastIndexByName.set(encodedNames[idx], idx)
  }
  const used = new Set()
  for (let idx = 0; idx < dyn.length; idx++) {
    if (lastIndexByName.get(encodedNames[idx]) === idx) used.add(encodedNames[idx])
  }
  const resolvedNames = new Array(dyn.length)
  let counter = 1
  for (let idx = 0; idx < dyn.length; idx++) {
    if (lastIndexByName.get(encodedNames[idx]) === idx) {
      resolvedNames[idx] = encodedNames[idx]
    } else {
      while (used.has(`param${counter}`)) counter++
      resolvedNames[idx] = `param${counter}`
      used.add(`param${counter}`)
      counter++
    }
  }

  // Pass 3: build each segment string (same present-token order as pass 1).
  const out = []
  let dynPtr = 0
  for (const seg of segments) {
    if (!groupActive(seg.group, groupParent, present)) continue

    let staticText = ''
    const paramNames = []
    let isCatchAll = false
    for (const t of seg.tokens) {
      if (!groupActive(t.group, groupParent, present)) continue
      if (t.type === 'static') {
        staticText += t.text
      } else {
        if (t.type === 'wildcard') isCatchAll = true
        paramNames.push(resolvedNames[dynPtr++])
      }
    }

    if (isCatchAll) {
      out.push(`{${paramNames.join('+')}}`) // terminal catch-all; static prefix subsumed (rule 5)
    } else if (paramNames.length === 0) {
      if (staticText !== '') out.push(encodeStaticSegment(staticText))
    } else if (paramNames.length === 1) {
      out.push(`{${paramNames[0]}}`)
    } else {
      out.push(`{${paramNames.join('+')}}`)
    }
  }

  const normalized = '/' + out.join('/')
  return compiled.trailingSlash && normalized !== '/' ? normalized + '/' : normalized
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
 * @returns {number}
 */
function presenceBitmask (optionalGroups, present) {
  let mask = 0
  for (let i = 0; i < optionalGroups.length; i++) {
    if (present.has(optionalGroups[i])) mask |= (1 << i)
  }
  return mask
}

/**
 * Normalize an Express route string. Express 5 only: `parse`/`makeMatcher` are path-to-regexp v8's
 * `parse()` and a `match()` factory; returns null when either is unavailable (Express 4).
 * @param {string} route - route string (the http.route value)
 * @param {object|null|undefined} params - req.params (fallback when the URL doesn't match)
 * @param {string|undefined} urlPath - request URL (query stripped here)
 * @param {(pattern: string) => { tokens: PathToRegexpToken[] } | undefined} parse
 * @param {(route: string) => ((url: string) => object | undefined) | undefined} makeMatcher
 * @returns {string|null}
 */
function normalizeRouteExpress (route, params, urlPath, parse, makeMatcher) {
  if (typeof route !== 'string' || !route) return null
  if (typeof parse !== 'function' || typeof makeMatcher !== 'function') return null

  let entry = routeCache.get(route)
  if (entry === undefined) {
    entry = compileRoute(route, parse, makeMatcher)
    routeCache.set(route, entry)
  }
  if (entry === null) return null
  if (entry.precomputed !== null) return entry.precomputed

  // Presence from path-to-regexp's matcher on the request URL (authoritative — handles
  // mergeParams=false sub-routers); fall back to req.params when there is no URL or it doesn't match.
  let matched
  if (urlPath) {
    const qIdx = urlPath.indexOf('?')
    matched = entry.matcher(qIdx === -1 ? urlPath : urlPath.slice(0, qIdx))
  }
  const present = resolvePresence(entry, matched ?? params)

  const mask = presenceBitmask(entry.optionalGroups, present)
  if (entry.variants === undefined) entry.variants = new Map()
  const cached = entry.variants.get(mask)
  if (cached !== undefined) return cached

  const result = renderRoute(entry, present)
  entry.variants.set(mask, result)
  return result
}

/**
 * Normalize an HTTP route from a request. Reads the framework from the span component tag.
 * @param {object} req
 * @returns {string|null}
 */
function normalizeRoute (req) {
  const spanContext = web.root(req)?.context()
  const component = spanContext?.getTag?.('component')

  // eslint-disable-next-line sonarjs/no-small-switch
  switch (component) {
    case 'express': {
      // path-to-regexp v8 `parse`/`match` exist only in Express 5 (v4 ships 0.x) → no tag otherwise.
      const parse = getParse()
      const makeMatcher = getMatch()
      if (parse === undefined || makeMatcher === undefined) return null
      // Reuse the http.route tag set by web.setRouteOrEndpointTag just before this hook; undefined
      // for the empty (root) route → null, matching http.route's own omission there.
      const route = spanContext.getTag(HTTP_ROUTE)
      return normalizeRouteExpress(route, req.params, req.originalUrl || req.url, parse, makeMatcher)
    }
    default:
      return null
  }
}

module.exports = {
  normalizeRoute,
  // exported for unit testing (the framework-agnostic core; the dispatcher is covered end-to-end
  // by the express plugin integration spec)
  normalizeRouteExpress,
}
