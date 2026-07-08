'use strict'

const web = require('../../plugins/util/web')
const { getParse } = require('../../../../datadog-instrumentations/src/path-to-regexp')

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
 *   6. Optional path elements (Express 5 `{/:id}`, optional static groups, optional catch-alls)
 *      are resolved per-request against the matched URL path, which also handles mergeParams=false
 *      sub-routers where parent params are absent from req.params.
 *
 * Design:
 *   The route string is parsed ONCE by path-to-regexp's own `parse()` (Express 5 / path-to-regexp
 *   v8), whose token tree is adapted into segment templates (tokensToSegments + compileRoute) and
 *   cached in routeCache keyed on the raw route string. Reusing the framework parser avoids
 *   re-implementing (and drifting from) path-to-regexp's grammar. Express 4 ships path-to-regexp
 *   0.x, which has no `parse()`; there we omit the tag (return null).
 *
 *   For routes with no optional elements the normalized string is precomputed; for optional
 *   routes the per-request presence is resolved (from the URL, or req.params as a fallback) and
 *   the rendered output is cached per presence bitmask.
 */

// Cap on optional groups per route. Keeps the presence bitmask within 32 bits, bounds the
// backtracking matcher, and caps the per-route variant cache at 2^N entries (4096 at N=12).
// Routes beyond this are omitted (return null) rather than mis-normalized.
const MAX_OPTIONAL_GROUPS = 12

// Upper bound on matcher steps per presence resolution; protects the request hot path from
// pathological backtracking. On exceedance the URL match aborts and we fall back to req.params.
const MAX_MATCH_STEPS = 10_000

// Per-route compiled-entry cache, keyed on the raw route string. Bounded by the app's declared
// route patterns (never attacker-controlled URLs), so it retains for the process lifetime.
const routeCache = new Map()

/**
 * @typedef {{ type: 'slash', group: number }
 *   | { type: 'static', text: string, group: number }
 *   | { type: 'param', name: string, group: number }
 *   | { type: 'wildcard', name: string | null, group: number }} RouteToken
 *
 * `group` is the id of the innermost enclosing optional `{...}` group (0 = top-level, always
 * present). A slash token also carries the group of its enclosing braces.
 *
 * `wildcardIndex` is the index of the segment's terminal wildcard token, or -1 (set at compile).
 * `matcher`/`prefixRegex` are compiled lazily on first use and cached on the segment.
 * @typedef {{ group: number, tokens: RouteToken[], wildcardIndex: number,
 *   matcher?: { regex: RegExp, presence: { id: number, name: string }[] }, prefixRegex?: RegExp }} RouteSegment
 *
 * @typedef {{ type: 'text', value: string }
 *   | { type: 'param', name: string }
 *   | { type: 'wildcard', name: string }
 *   | { type: 'group', tokens: PathToRegexpToken[] }} PathToRegexpToken
 *
 * @typedef {{
 *   segments: RouteSegment[],
 *   groupParent: Map<number, number>,
 *   optionalGroups: number[],
 *   trailingSlash: boolean,
 *   precomputed: string | null,
 *   variants?: Map<number, string>
 * }} CompiledRoute
 */

/**
 * Convert path-to-regexp's nested token tree into our flat segment model. Text tokens are split
 * on '/' into slash + static tokens; each `{...}` group token is assigned a fresh optional-group
 * id (parent tracked in groupParent), and its inner tokens inherit that id. Tokens are then split
 * into segments at slash boundaries. A trailing empty top-level segment denotes a declared
 * trailing slash.
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
        flat.push({ type: 'wildcard', name: token.name ?? null, group })
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
  if (segments.length > 0) {
    const last = segments[segments.length - 1]
    if (last.tokens.length === 0 && last.group === 0) {
      trailingSlash = true
      segments.pop()
    }
  }

  return { segments, groupParent, trailingSlash }
}

/**
 * Compile a raw route string into a CompiledRoute, or null when unsupported.
 * @param {string} route
 * @param {(pattern: string) => { tokens: PathToRegexpToken[] } | undefined} parse
 * @returns {CompiledRoute | null}
 */
function compileRoute (route, parse) {
  // `parse` (the getParse adapter) returns undefined on a parser throw or an unexpected shape, so
  // it never throws here.
  const parsed = parse(route)
  if (!Array.isArray(parsed?.tokens)) return null

  const { segments, groupParent, trailingSlash } = tokensToSegments(parsed.tokens)

  // An optional (non-top-level) empty segment is a slash inside a group ('/users{/}',
  // '/items{/:id/}'); we can't represent a per-request optional trailing slash, so omit.
  for (const seg of segments) {
    if (seg.tokens.length === 0 && seg.group !== 0) return null
  }

  // Drop empty (collapsed `//`) segments.
  const cleaned = segments.filter(s => s.tokens.length > 0)

  // Root route "/" (and any all-empty route) → single "/" element.
  if (cleaned.length === 0) {
    return { segments: [], groupParent: new Map(), optionalGroups: [], trailingSlash: false, precomputed: '/' }
  }

  // A catch-all must be terminal: any non-empty segment after the one containing a wildcard can't
  // be represented (the catch-all consumes the rest). Omit rather than emit a misleading route.
  for (let s = 0; s < cleaned.length - 1; s++) {
    if (cleaned[s].tokens.some(t => t.type === 'wildcard')) return null
  }

  // Reject single-segment shapes the delimiter-agnostic per-segment matcher can't resolve like
  // path-to-regexp does: a non-terminal wildcard in a segment ('/files/*path.:ext', '/*a-*b'), a
  // param/wildcard inside an intra-segment optional group ('/:a{.:b}c', '/:a{.:b}-*rest'), or more
  // than one intra-segment optional group ('/:a{.:b}{-:c}'). Static-only optional groups are fine.
  for (const seg of cleaned) {
    const intraGroups = new Set()
    seg.wildcardIndex = -1
    let prevDynamic = false
    for (let k = 0; k < seg.tokens.length; k++) {
      const t = seg.tokens[k]
      const dynamic = t.type === 'param' || t.type === 'wildcard'
      // Two adjacent dynamic tokens with no static between them ('/:a:b', '/:a*rest') — path-to-regexp
      // rejects this at compile ("missing text before …"), so Express never registers it.
      if (dynamic && prevDynamic) return null
      prevDynamic = dynamic
      if (t.type === 'wildcard') {
        if (k !== seg.tokens.length - 1) return null
        seg.wildcardIndex = k
      }
      if (isStrictDescendant(t.group, seg.group, groupParent)) {
        if (t.type === 'param' || t.type === 'wildcard') return null
        intraGroups.add(t.group)
      }
    }
    if (intraGroups.size > 1) return null
  }

  // An optional group that directly spans more than one URL segment ('{/:a/:b}') is atomic in
  // path-to-regexp (all its segments present or all absent), but our matcher toggles them
  // independently and a sibling optional can steal one; omit rather than mis-assign.
  const directSegmentCount = new Map()
  for (const seg of cleaned) {
    if (seg.group !== 0) directSegmentCount.set(seg.group, (directSegmentCount.get(seg.group) ?? 0) + 1)
  }
  for (const count of directSegmentCount.values()) {
    if (count > 1) return null
  }

  // Collapse "structural-only" optional groups — a `{...}` that wraps only nested group(s) and has
  // no segment/token of its own (e.g. the outer braces in '/a{{/b}}'). Such a wrapper adds nesting
  // but no content, and the matcher can never mark it present from the URL. Reparent each
  // represented group to its nearest represented ancestor and drop the empty wrappers.
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

  const optionalGroups = [...represented].sort((a, b) => a - b)

  // Guard against pathological routes: too many optional groups makes the presence bitmask
  // (1 << i) overflow 32 bits and the backtracking matcher blow up. Omit rather than risk a
  // wrong (aliased) cached result or an event-loop stall.
  if (optionalGroups.length > MAX_OPTIONAL_GROUPS) return null

  const compiled = {
    segments: cleaned,
    groupParent: effectiveParent,
    optionalGroups,
    trailingSlash,
    precomputed: null,
  }

  // No optional groups → the normalized output is fixed; precompute it once.
  if (optionalGroups.length === 0) {
    compiled.precomputed = renderRoute(compiled, EMPTY_SET)
  }
  return compiled
}

const EMPTY_SET = new Set()

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
 * True when group `g` is a strict descendant of `ancestor` (i.e. nested more deeply inside it).
 * @param {number} g
 * @param {number} ancestor
 * @param {Map<number, number>} groupParent
 * @returns {boolean}
 */
function isStrictDescendant (g, ancestor, groupParent) {
  let p = groupParent.get(g)
  while (p !== undefined) {
    if (p === ancestor) return true
    if (p === 0) return false
    p = groupParent.get(p)
  }
  return false
}

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
 * @param {CompiledRoute} compiled
 * @param {Set<number>} present
 * @returns {string}
 */
function renderRoute (compiled, present) {
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

  // Pass 2: resolve names. Uniqueness is computed on ENCODED names (the form that appears in the
  // output), so two distinct raw names that encode identically don't collide. A token keeps its
  // name iff it is the LAST present occurrence of that encoded name (the value Express keeps in
  // req.params); earlier duplicates and unnamed wildcards become paramN placeholders, skipping
  // any N equal to a surviving name.
  const encodedNames = new Array(dyn.length)
  const lastIndexByName = new Map()
  for (let idx = 0; idx < dyn.length; idx++) {
    if (dyn[idx].name != null) {
      encodedNames[idx] = encodeParamName(dyn[idx].name)
      lastIndexByName.set(encodedNames[idx], idx)
    }
  }
  const used = new Set()
  for (let idx = 0; idx < dyn.length; idx++) {
    if (encodedNames[idx] != null && lastIndexByName.get(encodedNames[idx]) === idx) {
      used.add(encodedNames[idx])
    }
  }
  const resolvedNames = new Array(dyn.length)
  let counter = 1
  for (let idx = 0; idx < dyn.length; idx++) {
    if (encodedNames[idx] != null && lastIndexByName.get(encodedNames[idx]) === idx) {
      resolvedNames[idx] = encodedNames[idx]
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
  for (const seg of segments) {
    if (!groupActive(seg.group, groupParent, present)) continue

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
      // Catch-all is terminal (rule 5). A static prefix is subsumed into the single element, but
      // any preceding dynamic params in the same segment are combined with it via '+'.
      out.push(`{${paramNames.join('+')}}`)
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
 * Build (and cache) a regex that matches a single URL segment against a route segment, plus the
 * list of intra-segment optional group ids (each has a named marker capture in the regex).
 *
 * Tokens at the segment's base group are mandatory; tokens in a deeper (optional) group are
 * wrapped in an optional non-capturing group with a named marker capture (?<_ddgN>) so we can
 * detect whether that group matched by name (robust to capture-index shifts).
 *
 * @param {RouteSegment} seg
 * @param {Map<number, number>} groupParent
 * @returns {{ regex: RegExp, presence: { id: number, name: string }[] }}
 */
function getSegmentMatcher (seg, groupParent) {
  if (seg.matcher !== undefined) return seg.matcher

  let pattern = ''
  const presence = []
  let openGroup = 0 // currently-open intra-optional group id (0 = none)

  for (const t of seg.tokens) {
    // A token is an intra-segment optional only when its group is nested strictly deeper than
    // the segment's group; same-group or ancestor-group tokens are mandatory within the segment.
    const intraOptional = isStrictDescendant(t.group, seg.group, groupParent)

    // Close an open intra-optional group when we leave it.
    if (openGroup !== 0 && t.group !== openGroup) {
      pattern += ')?'
      openGroup = 0
    }
    // Open an intra-optional group with a NAMED marker capture. A named group is read by name
    // (m.groups), so it is immune to capture-index shifts.
    if (intraOptional && openGroup === 0) {
      const name = markerName(t.group)
      pattern += `(?:(?<${name}>)` // empty marker: defined iff this group matched
      presence.push({ id: t.group, name })
      openGroup = t.group
    }

    // Match the literal route text — that is what Express/path-to-regexp match against the raw URL
    // (encoding is only for the rendered output). Params use a generic lazy single-segment matcher;
    // wildcard segments never reach here (matchSegmentHere routes them to the catch-all branch).
    pattern += t.type === 'static' ? escapeRegex(t.text) : '[^/]+?'
  }
  if (openGroup !== 0) pattern += ')?'

  // Case-insensitive: Express routing is case-insensitive by default; the normalized output still
  // preserves the route's declared case. The pattern is built only from escapeRegex output, the
  // fixed '[^/]+?', and numeric marker names, so RegExp construction cannot throw.
  seg.matcher = { regex: new RegExp('^' + pattern + '$', 'i'), presence }
  return seg.matcher
}

function escapeRegex (str) {
  return str.replaceAll(/[-[\]{}()*+?.,\\^$|#\s]/g, String.raw`\$&`)
}

/**
 * Regex named-group identifier for an optional group's presence marker.
 * @param {number} groupId
 * @returns {string}
 */
function markerName (groupId) {
  return `_ddg${groupId}`
}

/**
 * Build (and cache on the segment) a start-anchored, case-insensitive regex for the tokens
 * preceding a wildcard in a segment (e.g. 'v' in 'v*rest'), to validate the prefix before the
 * catch-all consumes. Matches literal route text (see getSegmentMatcher).
 * @param {RouteSegment} seg
 * @param {number} wIdx - index of the wildcard token in seg.tokens
 * @returns {RegExp}
 */
function getWildcardPrefixRegex (seg, wIdx) {
  if (seg.prefixRegex !== undefined) return seg.prefixRegex
  let pfx = ''
  for (let k = 0; k < wIdx; k++) {
    const t = seg.tokens[k]
    pfx += t.type === 'static' ? escapeRegex(t.text) : '[^/]+?'
  }
  seg.prefixRegex = new RegExp('^' + pfx, 'i')
  return seg.prefixRegex
}

/**
 * Resolve which optional groups are present by matching the route segments against the URL
 * path segments. Matching is greedy present-first, mirroring path-to-regexp v8's left-to-right
 * assignment — so the resolved presence matches what Express itself matched.
 * @param {CompiledRoute} compiled
 * @param {string[]} urlSegs
 * @returns {{ present: Set<number> | null, aborted: boolean }}
 */
function resolvePresenceFromUrl (compiled, urlSegs) {
  const present = new Set()
  matchStepsRemaining = MAX_MATCH_STEPS
  const matched = matchSegments(compiled, 0, urlSegs, 0, present)
  return { present: matched ? present : null, aborted: matchStepsRemaining < 0 }
}

// Step budget for the current matchSegments traversal. Safe as module state because presence
// resolution is synchronous and non-reentrant (each request resolves fully before the next).
let matchStepsRemaining = MAX_MATCH_STEPS

/**
 * Backtracking matcher: try to match segments[si..] against urlSegs[ui..], recording present
 * optional groups in `present`. Each optional segment is tried present-first, then absent.
 * @param {CompiledRoute} compiled
 * @param {number} si
 * @param {string[]} urlSegs
 * @param {number} ui
 * @param {Set<number>} present
 * @returns {boolean}
 */
function matchSegments (compiled, si, urlSegs, ui, present) {
  if (--matchStepsRemaining < 0) return false // budget exhausted → abort (caller falls back to params)
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
    present.add(seg.group)
    if (matchSegmentHere(compiled, si, urlSegs, ui, present)) return true
    present.delete(seg.group)
    return matchSegments(compiled, si + 1, urlSegs, ui, present) // try absent
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
  const wIdx = seg.wildcardIndex

  if (wIdx !== -1) {
    const wildcard = seg.tokens[wIdx]
    // Tokens before the wildcard (e.g. 'v' in 'v*rest') must match the URL segment start first.
    if (wIdx > 0) {
      if (ui >= urlSegs.length) return false
      if (!getWildcardPrefixRegex(seg, wIdx).test(urlSegs[ui])) return false
    }
    // A wildcard needs at least one URL segment. Zero left → this segment can't match: an optional
    // catch-all backtracks to absent, and a required one (path-to-regexp requires >=1) fails.
    if (ui >= urlSegs.length) return false
    if (wildcard.group !== 0) present.add(wildcard.group)
    return matchSegments(compiled, si + 1, urlSegs, urlSegs.length, present)
  }

  if (ui >= urlSegs.length) return false
  const { regex, presence } = getSegmentMatcher(seg, compiled.groupParent)
  const m = regex.exec(urlSegs[ui])
  if (!m) return false

  // Fast path: segment has no intra-segment optional groups → no presence to record/roll back.
  if (presence.length === 0) return matchSegments(compiled, si + 1, urlSegs, ui + 1, present)

  const added = []
  for (const entry of presence) {
    if (m.groups?.[entry.name] !== undefined) {
      present.add(entry.id)
      added.push(entry.id)
    }
  }
  if (matchSegments(compiled, si + 1, urlSegs, ui + 1, present)) return true
  for (const g of added) present.delete(g)
  return false
}

/**
 * Best-effort presence from req.params: an optional group is present iff one of its param
 * tokens has a defined own-property value in params. Static-only optional groups can't be
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
 * Split a URL path into its non-empty segments in a single pass (no intermediate `filter`).
 * @param {string} urlPath
 * @returns {string[]}
 */
function splitPathSegments (urlPath) {
  const segments = []
  let start = 0
  for (let i = 0; i <= urlPath.length; i++) {
    if (i === urlPath.length || urlPath[i] === '/') {
      if (i > start) segments.push(urlPath.slice(start, i))
      start = i + 1
    }
  }
  return segments
}

/**
 * Normalize an Express route string to the RFC-1103 _dd.appsec.normalized_route format.
 * Express 5 only: `parse` is path-to-regexp v8's `parse()`. Returns null when `parse` is
 * unavailable (Express 4 ships path-to-regexp 0.x, which has no `parse()`).
 *
 * @param {string} route - Express route string (e.g. the value of the http.route span tag)
 * @param {object|null|undefined} params - req.params from the matched request
 * @param {string|undefined} urlPath - URL path (any query string is stripped here); used to
 *   resolve optional elements (and to recover parent params dropped by mergeParams=false routers)
 * @param {((pattern: string) => { tokens: PathToRegexpToken[] } | undefined) | undefined} parse
 * @returns {string|null} Normalized route, or null when normalization is not possible
 */
function normalizeRouteExpress (route, params, urlPath, parse) {
  if (typeof route !== 'string' || !route) return null
  if (typeof parse !== 'function') return null

  let entry = routeCache.get(route)
  if (entry === undefined) {
    entry = compileRoute(route, parse)
    routeCache.set(route, entry)
  }
  if (entry === null) return null

  // No optional groups → fixed result (computed once at compile time).
  if (entry.precomputed !== null) return entry.precomputed

  // Resolve which optional groups are present. The URL is authoritative — it correctly handles
  // mergeParams=false sub-routers (where a parent param is missing from req.params) and routes
  // that reuse a param name across groups. On step-budget abort or a clean URL/route mismatch we
  // fall back to a params-only resolution.
  let present
  if (urlPath) {
    // Strip the query string here (lazily): only this optional-route branch needs it, not the
    // precomputed fast path above.
    const qIdx = urlPath.indexOf('?')
    const urlSegs = splitPathSegments(qIdx === -1 ? urlPath : urlPath.slice(0, qIdx))
    const { present: urlPresent, aborted } = resolvePresenceFromUrl(entry, urlSegs)
    present = (aborted || urlPresent === null)
      ? resolvePresenceFromParams(entry, params)
      : urlPresent
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
  const context = web.getContext(req)
  const component = context?.span?.context()?.getTag?.('component')

  // eslint-disable-next-line sonarjs/no-small-switch
  switch (component) {
    case 'express': {
      // v8 `parse()` exists only in Express 5 (v4 ships 0.x); getParse() is undefined there → no tag.
      // It's process-global (last-loaded): a mixed v4+v8 process could tag v4 routes the v8 grammar
      // also accepts, but those normalize identically, so the output stays correct.
      const parse = getParse()
      if (parse === undefined) return null
      const paths = context.paths
      // Same route reconstruction as web.js's http.route. The router plugin maps a bare '/' (and
      // '*') to '', so root yields route '' → null — intentionally matching http.route, which is
      // itself omitted for the empty route.
      const route = paths && (paths.length > 1 ? paths.join('') : paths[0])
      return normalizeRouteExpress(route, req.params, req.originalUrl || req.url, parse)
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
