'use strict'

const web = require('../../plugins/util/web')

/**
 * Normalize an HTTP route to the RFC-1103 _dd.appsec.normalized_route format.
 *
 * Rules applied:
 *   1. Starts with /; trailing slash only if the route was declared with one.
 *   2. No empty elements (consecutive slashes are collapsed).
 *   3. Static segments: only [A-Za-z0-9.-~_]; other chars are percent-encoded (UTF-8).
 *   4. Dynamic params: {name}. Param names may contain any char except /?#+{} (those are
 *      URL-encoded; + is the reserved combining marker). Nameless params (unnamed wildcards
 *      and shadowed duplicate names) get a paramN placeholder, declaration-ordered, skipping
 *      any N that collides with a surviving framework-supplied name. All names end up unique.
 *   5. One URL segment = one atomic element. Multiple params in one segment combine as {a+b}.
 *      A catch-all is a single terminal element.
 *   6. Optional path elements (Express 4 `:id?`, Express 5 `{/:id}`, optional static groups,
 *      optional catch-alls) are resolved per-request against the matched URL path, which also
 *      handles mergeParams=false sub-routers where parent params are absent from req.params.
 *
 * Design:
 *   A route string is parsed ONCE into a token model (parseRoute), compiled into segment
 *   templates (compileRoute), and cached in routeCache keyed on the raw route string. For
 *   routes with no optional elements the normalized string is precomputed; for optional
 *   routes the per-request presence is resolved (from the URL, or req.params as a fallback)
 *   and the rendered output is cached per presence bitmask.
 */

// Unquoted param/wildcard name: one or more [A-Za-z0-9_]
const NAME_RE = /^[A-Za-z0-9_]+/

// Per-route compiled-entry cache, keyed on the raw route string.
const routeCache = new Map()

// Per-segment matching regex cache.
const segmentRegexCache = new Map()

/**
 * @typedef {{ type: 'slash' }
 *   | { type: 'static', text: string, group: number }
 *   | { type: 'param', name: string, group: number, constraint: string | undefined }
 *   | { type: 'wildcard', name: string | null, group: number, zeroOrMore: boolean }} RouteToken
 *
 * `group` is the id of the innermost enclosing optional `{...}` group (0 = top-level, always
 * present). A slash token also carries the group of its enclosing braces.
 *
 * @typedef {{ group: number, tokens: RouteToken[] }} RouteSegment
 *
 * @typedef {{
 *   segments: RouteSegment[],
 *   groupParent: Map<number, number>,
 *   optionalGroups: number[],
 *   trailingSlash: boolean,
 *   precomputed: string | null
 * }} CompiledRoute
 */

// ---------------------------------------------------------------------------
// Parser: route string → token list
// ---------------------------------------------------------------------------

/**
 * Read a param/wildcard name at position i: either "quoted" (any char but ") or unquoted
 * [A-Za-z0-9_]+. Returns { name, next } or null when no valid name is present.
 * @param {string} route
 * @param {number} i
 * @returns {{ name: string, next: number } | null}
 */
function parseName (route, i) {
  if (route[i] === '"') {
    let j = i + 1
    while (j < route.length && route[j] !== '"') j++
    if (j >= route.length) return null // unterminated quote
    const name = route.slice(i + 1, j)
    return name ? { name, next: j + 1 } : null
  }
  const m = NAME_RE.exec(route.slice(i))
  return m ? { name: m[0], next: i + m[0].length } : null
}

/**
 * Consume a balanced (...) inline constraint starting at i (route[i] === '('). Returns the
 * inner text and the index past the closing ')', or null when unbalanced.
 * @param {string} route
 * @param {number} i
 * @returns {{ text: string, next: number } | null}
 */
function consumeParens (route, i) {
  let depth = 0
  for (let j = i; j < route.length; j++) {
    if (route[j] === '(') depth++
    else if (route[j] === ')') {
      depth--
      if (depth === 0) return { text: route.slice(i + 1, j), next: j + 1 }
    }
  }
  return null
}

/**
 * Parse an Express route (v4 or v5) into a token list, tracking optional `{...}` group nesting.
 * Returns null for syntax we cannot safely normalize (standalone parens, unbalanced braces, …).
 * @param {string} route
 * @returns {{ tokens: RouteToken[], groupParent: Map<number, number> } | null}
 */
function parseRoute (route) {
  const tokens = []
  const groupStack = [0]
  const groupParent = new Map()
  let nextGroupId = 0
  let staticBuf = ''
  let i = 0

  const flush = () => {
    if (staticBuf) {
      tokens.push({ type: 'static', text: staticBuf, group: groupStack[groupStack.length - 1] })
      staticBuf = ''
    }
  }

  while (i < route.length) {
    const c = route[i]
    if (c === '{') {
      flush()
      nextGroupId++
      groupParent.set(nextGroupId, groupStack[groupStack.length - 1])
      groupStack.push(nextGroupId)
      i++
    } else if (c === '}') {
      flush()
      if (groupStack.length === 1) return null // unbalanced
      groupStack.pop()
      i++
    } else if (c === '/') {
      flush()
      tokens.push({ type: 'slash', group: groupStack[groupStack.length - 1] })
      i++
    } else if (c === ':') {
      flush()
      const nm = parseName(route, i + 1)
      if (!nm) return null
      i = nm.next
      let constraint
      if (route[i] === '(') {
        const con = consumeParens(route, i)
        if (!con) return null
        constraint = con.text
        i = con.next
      }
      let mod = ''
      if (route[i] === '?' || route[i] === '*' || route[i] === '+') {
        mod = route[i]
        i++
      }
      const currentGroup = groupStack[groupStack.length - 1]
      if (mod === '*' || mod === '+') {
        // Catch-all: optionality comes only from an enclosing brace group, not the modifier
        // (a trailing catch-all is always rendered per RFC rule 5).
        tokens.push({ type: 'wildcard', name: nm.name, group: currentGroup, zeroOrMore: mod === '*' })
      } else if (mod === '?') {
        // Express 4 optional param: wrap the param AND its immediately-preceding delimiter
        // (the '/' or the last char of the preceding static) in a synthetic optional group,
        // mirroring path-to-regexp's prefix-optional semantics.
        nextGroupId++
        const gN = nextGroupId
        groupParent.set(gN, currentGroup)
        tokens.push({ type: 'param', name: nm.name, group: gN, constraint })
        const prev = tokens[tokens.length - 2]
        if (prev) {
          if (prev.type === 'slash' && prev.group === currentGroup) {
            prev.group = gN
          } else if (prev.type === 'static' && prev.group === currentGroup && prev.text.length > 0) {
            const delim = prev.text[prev.text.length - 1]
            prev.text = prev.text.slice(0, -1)
            tokens.splice(-1, 0, { type: 'static', text: delim, group: gN })
            if (prev.text === '') tokens.splice(-3, 1)
          }
        }
      } else {
        tokens.push({ type: 'param', name: nm.name, group: currentGroup, constraint })
      }
    } else if (c === '*') {
      flush()
      const nm = parseName(route, i + 1)
      i = nm ? nm.next : i + 1
      const group = groupStack[groupStack.length - 1]
      tokens.push({ type: 'wildcard', name: nm ? nm.name : null, group, zeroOrMore: true })
    } else if (c === '(' || c === ')') {
      return null // standalone group / stray paren — unsupported
    } else {
      staticBuf += c
      i++
    }
  }
  flush()
  if (groupStack.length !== 1) return null // unbalanced
  return { tokens, groupParent }
}

// ---------------------------------------------------------------------------
// Compiler: token list → segment templates + cached entry
// ---------------------------------------------------------------------------

/**
 * Compile a raw route string into a CompiledRoute, or null when unsupported.
 * @param {string} route
 * @returns {CompiledRoute | null}
 */
function compileRoute (route) {
  if (route.charAt(0) === '(') return null // RegExp route, stored as "(/.../flags)"

  const parsed = parseRoute(route)
  if (!parsed) return null
  const { tokens, groupParent } = parsed

  // Split tokens into segments at slash boundaries; each segment's group is its leading slash's.
  /** @type {RouteSegment[]} */
  const segments = []
  let cur = null
  for (const t of tokens) {
    if (t.type === 'slash') {
      if (cur) segments.push(cur)
      cur = { group: t.group, tokens: [] }
    } else {
      if (!cur) cur = { group: 0, tokens: [] }
      cur.tokens.push(t)
    }
  }
  if (cur) segments.push(cur)

  // Root route "/" → single empty top-level segment.
  if (segments.length === 1 && segments[0].tokens.length === 0) {
    return { segments: [], groupParent, optionalGroups: [], trailingSlash: false, precomputed: '/' }
  }

  // A trailing empty top-level segment denotes a declared trailing slash.
  let trailingSlash = false
  if (segments.length > 0) {
    const last = segments[segments.length - 1]
    if (last.tokens.length === 0 && last.group === 0) {
      trailingSlash = true
      segments.pop()
    }
  }

  // Drop empty (collapsed `//`) segments.
  const cleaned = segments.filter(s => s.tokens.length > 0)

  const optionalGroups = []
  for (const [id] of groupParent) optionalGroups.push(id)
  optionalGroups.sort((a, b) => a - b)

  const compiled = { segments: cleaned, groupParent, optionalGroups, trailingSlash, precomputed: null }

  // No optional groups → the normalized output is fixed; precompute it once.
  if (optionalGroups.length === 0) {
    compiled.precomputed = renderRoute(compiled, EMPTY_SET)
  }
  return compiled
}

const EMPTY_SET = new Set()

// ---------------------------------------------------------------------------
// Group helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Renderer: segment templates + present-group set → normalized string
// ---------------------------------------------------------------------------

/**
 * URL-encode characters outside the RFC-1103 static-constant alphabet [A-Za-z0-9.-~_].
 * The 'u' flag iterates whole codepoints so surrogate pairs encode as correct multi-byte UTF-8.
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
 * Returns null when the route cannot be represented (e.g. a non-terminal catch-all).
 * @param {CompiledRoute} compiled
 * @param {Set<number>} present
 * @returns {string | null}
 */
function renderRoute (compiled, present) {
  if (compiled.precomputed !== null) return compiled.precomputed

  const { segments, groupParent } = compiled

  // Pass 1: collect the present dynamic tokens (param/wildcard) in declaration order.
  const dyn = []
  for (const seg of segments) {
    if (!groupActive(seg.group, groupParent, present)) continue
    for (const t of seg.tokens) {
      if (t.type === 'static') continue
      if (!groupActive(t.group, groupParent, present)) continue
      dyn.push(t)
    }
  }

  // Pass 2: resolve names. A named token keeps its name iff it is the LAST present occurrence
  // of that name (the value Express keeps in req.params); earlier duplicates and unnamed
  // wildcards become paramN placeholders, skipping any N equal to a surviving name.
  const lastIndexByName = new Map()
  for (let idx = 0; idx < dyn.length; idx++) {
    if (dyn[idx].name != null) lastIndexByName.set(dyn[idx].name, idx)
  }
  const used = new Set()
  for (let idx = 0; idx < dyn.length; idx++) {
    const t = dyn[idx]
    if (t.name != null && lastIndexByName.get(t.name) === idx) used.add(t.name)
  }
  const resolvedNames = new Array(dyn.length)
  let counter = 1
  for (let idx = 0; idx < dyn.length; idx++) {
    const t = dyn[idx]
    if (t.name != null && lastIndexByName.get(t.name) === idx) {
      resolvedNames[idx] = encodeParamName(t.name)
    } else {
      while (used.has(`param${counter}`)) counter++
      resolvedNames[idx] = `param${counter}`
      used.add(`param${counter}`)
      counter++
    }
  }

  // Pass 3: build each segment string (same present-token iteration order as pass 1).
  const out = []
  let dynPtr = 0
  let catchAllSeen = false
  for (const seg of segments) {
    if (!groupActive(seg.group, groupParent, present)) continue
    if (catchAllSeen) return null // a present segment after a catch-all → non-terminal, unsafe

    let staticText = ''
    const paramNames = []
    let isCatchAll = false
    for (const t of seg.tokens) {
      if (!groupActive(t.group, groupParent, present)) continue
      if (t.type === 'static') {
        staticText += t.text
      } else if (t.type === 'wildcard') {
        isCatchAll = true
        paramNames.push(resolvedNames[dynPtr++])
      } else {
        paramNames.push(resolvedNames[dynPtr++])
      }
    }

    if (isCatchAll) {
      // Catch-all (with any static prefix) is a single terminal dynamic element (rule 5).
      out.push(`{${paramNames[0]}}`)
      catchAllSeen = true
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

// ---------------------------------------------------------------------------
// Per-segment matching regex (resolves intra-segment optional groups + constraints)
// ---------------------------------------------------------------------------

/**
 * Build (and cache) a regex that matches a single URL segment against a route segment, plus a
 * map from each intra-segment optional group id to the capture index that signals its presence.
 *
 * Tokens at the segment's base group are mandatory; tokens in a deeper (optional) group are
 * wrapped in an optional non-capturing group with a leading marker capture so we can detect
 * whether that group matched.
 *
 * @param {RouteSegment} seg
 * @returns {{ regex: RegExp, presence: Array<[number, number]> }}
 */
function getSegmentMatcher (seg) {
  const cached = segmentRegexCache.get(seg)
  if (cached !== undefined) return cached

  let pattern = ''
  let captureIdx = 0
  const presence = []
  let openGroup = 0 // currently-open intra-optional group id (0 = none)

  for (const t of seg.tokens) {
    // Close an open intra-optional group when we leave it.
    if (openGroup !== 0 && t.group !== openGroup) {
      pattern += ')?'
      openGroup = 0
    }
    // Open an intra-optional group (deeper than the segment base) with a marker capture.
    if (t.group !== seg.group && openGroup === 0) {
      pattern += '(?:'
      captureIdx++
      pattern += '()' // empty marker capture: defined iff this optional group matched
      presence.push([t.group, captureIdx])
      openGroup = t.group
    }

    if (t.type === 'static') {
      pattern += escapeRegex(t.text)
    } else if (t.type === 'param') {
      // Lazy so a trailing optional group (e.g. ':id{.:format}') can still match its part
      // instead of the greedy base param swallowing the whole segment. A constraint is used
      // only when it is itself a valid regex; otherwise it is ignored (generic single-segment).
      pattern += isValidRegex(t.constraint) ? `(?:${t.constraint})` : '[^/]+?'
    } else { // wildcard inside a single-segment match (rare); match the rest of the segment
      pattern += '[^/]*'
    }
  }
  if (openGroup !== 0) pattern += ')?'

  let regex
  try {
    regex = new RegExp('^' + pattern + '$')
  } catch {
    regex = /^[^/]+$/ // last-resort fallback (should not happen: each fragment is pre-validated)
  }
  const result = { regex, presence }
  segmentRegexCache.set(seg, result)
  return result
}

function escapeRegex (str) {
  return str.replaceAll(/[-[\]{}()*+?.,\\^$|#\s]/g, String.raw`\$&`)
}

/**
 * @param {string|undefined} src
 * @returns {boolean} true when src is a non-empty string that compiles as a standalone regex
 */
function isValidRegex (src) {
  if (!src) return false
  try {
    new RegExp(src) // eslint-disable-line no-new
    return true
  } catch {
    return false
  }
}

/**
 * Does this segment contain a catch-all wildcard token?
 * @param {RouteSegment} seg
 * @returns {RouteToken | null}
 */
function segmentWildcard (seg) {
  for (const t of seg.tokens) {
    if (t.type === 'wildcard') return t
  }
  return null
}

// ---------------------------------------------------------------------------
// Presence resolution from the request URL (rule 6)
// ---------------------------------------------------------------------------

/**
 * Resolve which optional groups are present by matching the route segments against the URL
 * path segments. Returns the set of present group ids, or null when the route does not match.
 * @param {CompiledRoute} compiled
 * @param {string[]} urlSegs
 * @returns {Set<number> | null}
 */
function resolvePresenceFromUrl (compiled, urlSegs) {
  const present = new Set()
  return matchSegments(compiled, 0, urlSegs, 0, present) ? present : null
}

/**
 * Backtracking matcher: try to match segments[si..] against urlSegs[ui..], recording present
 * optional groups in `present`. Greedy (tries "present" before "absent" for optional segments).
 * @param {CompiledRoute} compiled
 * @param {number} si
 * @param {string[]} urlSegs
 * @param {number} ui
 * @param {Set<number>} present
 * @returns {boolean}
 */
function matchSegments (compiled, si, urlSegs, ui, present) {
  const { segments, groupParent } = compiled
  if (si === segments.length) return ui === urlSegs.length

  const seg = segments[si]
  const optional = seg.group !== 0
  const parentPresent = seg.group === 0 || groupActive(groupParent.get(seg.group), groupParent, present)

  // Optional segment whose parent group is absent can only be absent too.
  if (optional && !parentPresent) {
    return matchSegments(compiled, si + 1, urlSegs, ui, present)
  }

  if (optional) {
    // Try present first.
    present.add(seg.group)
    if (matchSegmentHere(compiled, si, urlSegs, ui, present)) return true
    present.delete(seg.group)
    // Then absent.
    return matchSegments(compiled, si + 1, urlSegs, ui, present)
  }

  return matchSegmentHere(compiled, si, urlSegs, ui, present)
}

/**
 * Match a single (now-present) segment against urlSegs[ui], then continue. Records intra-segment
 * optional groups, and handles catch-all segments (consume the remaining URL).
 * @returns {boolean}
 */
function matchSegmentHere (compiled, si, urlSegs, ui, present) {
  const { segments } = compiled
  const seg = segments[si]
  const wildcard = segmentWildcard(seg)

  if (wildcard) {
    if (ui >= urlSegs.length) {
      // Optional catch-all ({/*path}) matching zero segments → treat as absent (Express drops it).
      if (wildcard.group !== 0) return false
      // Required `+` catch-all needs at least one segment.
      if (!wildcard.zeroOrMore) return false
    }
    if (wildcard.group !== 0) present.add(wildcard.group)
    return matchSegments(compiled, si + 1, urlSegs, urlSegs.length, present)
  }

  if (ui >= urlSegs.length) return false
  const { regex, presence } = getSegmentMatcher(seg)
  const m = regex.exec(urlSegs[ui])
  if (!m) return false

  const added = []
  for (const [groupId, captureIdx] of presence) {
    if (m[captureIdx] !== undefined) {
      present.add(groupId)
      added.push(groupId)
    }
  }
  if (matchSegments(compiled, si + 1, urlSegs, ui + 1, present)) return true
  for (const g of added) present.delete(g)
  return false
}

// ---------------------------------------------------------------------------
// Presence resolution from req.params (fallback when no URL path is available)
// ---------------------------------------------------------------------------

/**
 * Best-effort presence from req.params: an optional group is present iff one of its param
 * tokens has a truthy own-property value in params. Static-only optional groups can't be
 * determined this way and are treated as absent. Marks ancestor groups present too.
 * @param {CompiledRoute} compiled
 * @param {object | null | undefined} params
 * @returns {Set<number>}
 */
function resolvePresenceFromParams (compiled, params) {
  const present = new Set()
  if (params == null) return present
  const { segments, groupParent } = compiled
  for (const seg of segments) {
    for (const t of seg.tokens) {
      if (t.group === 0 || t.name == null) continue
      if (Object.hasOwn(params, t.name) && params[t.name]) {
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute a stable bitmask key for a present-group set (group ids are small, route-local).
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
 * Normalize an Express route string to the RFC-1103 _dd.appsec.normalized_route format.
 *
 * @param {string} route - Express route string (e.g. the value of the http.route span tag)
 * @param {object|null|undefined} params - req.params from the matched request
 * @param {string|undefined} urlPath - URL path without query string; used to resolve optional
 *   elements (and to recover parent params dropped by mergeParams=false sub-routers)
 * @returns {string|null} Normalized route, or null when normalization is not possible
 */
function normalizeRouteExpress (route, params, urlPath) {
  if (typeof route !== 'string' || !route) return null

  let entry = routeCache.get(route)
  if (entry === undefined) {
    entry = compileRoute(route)
    routeCache.set(route, entry)
  }
  if (entry === null) return null

  // No optional groups → fixed result (computed once at compile time).
  if (entry.precomputed !== null) return entry.precomputed

  // Optional route: resolve which groups are present, then render (cached per presence bitmask).
  let present
  if (urlPath) {
    const urlSegs = urlPath.split('/').filter(Boolean)
    present = resolvePresenceFromUrl(entry, urlSegs) ?? resolvePresenceFromParams(entry, params)
  } else {
    present = resolvePresenceFromParams(entry, params)
  }

  const mask = presenceBitmask(entry.optionalGroups, present)
  if (entry.variants === undefined) entry.variants = new Map()
  const cached = entry.variants.get(mask)
  if (cached !== undefined) return cached

  const result = renderRoute(entry, present)
  entry.variants.set(mask, result)
  return result
}

/**
 * Normalize an HTTP route from a request to the RFC-1103 _dd.appsec.normalized_route format.
 * Reads the framework from the span component tag and dispatches to the framework normalizer.
 *
 * @param {object} req - the incoming request object
 * @returns {string|null} Normalized route, or null when normalization is not possible
 */
function normalizeRoute (req) {
  const component = web.root(req)?.context()?.getTag?.('component')

  // eslint-disable-next-line sonarjs/no-small-switch
  switch (component) {
    case 'express': {
      const paths = web.getContext(req)?.paths
      const route = paths && (paths.length > 1 ? paths.join('') : paths[0])
      const raw = req.originalUrl || req.url
      const qIdx = raw ? raw.indexOf('?') : -1
      const urlPath = qIdx === -1 ? raw : raw.slice(0, qIdx)
      return normalizeRouteExpress(route, req.params, urlPath)
    }
    default:
      return null
  }
}

module.exports = {
  normalizeRoute,
  normalizeRouteExpress,
  // exported for unit testing
  parseRoute,
  compileRoute,
  renderRoute,
  resolvePresenceFromUrl,
}
