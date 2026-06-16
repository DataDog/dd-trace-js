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

// Unquoted param/wildcard name: JS-identifier-ish — Unicode letters/digits plus _ and $
// (path-to-regexp v8 accepts identifier characters, not just [A-Za-z0-9_]).
const NAME_RE = /^[\p{L}\p{N}_$]+/u

// Cap on optional groups per route. Keeps the presence bitmask within 32 bits, bounds the
// backtracking matcher, and caps the per-route variant cache at 2^N entries (4096 at N=12).
// Routes beyond this are omitted (return null) rather than mis-normalized.
const MAX_OPTIONAL_GROUPS = 12

// Upper bound on matcher steps per presence resolution; protects the request hot path from
// pathological backtracking. On exceedance the URL match aborts and we fall back to req.params.
const MAX_MATCH_STEPS = 10_000

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
 *   precomputed: string | null,
 *   variants?: Map<number, string | null>
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
    // Quoted name: any char until the closing quote; a backslash escapes the next char.
    let name = ''
    let j = i + 1
    while (j < route.length && route[j] !== '"') {
      if (route[j] === '\\' && j + 1 < route.length) j++
      name += route[j]
      j++
    }
    if (j >= route.length) return null // unterminated quote
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
 * Parse an Express route into a token list, tracking optional `{...}` group nesting.
 * Dialect differs by major version: Express 5 (path-to-regexp v8) uses `{...}` optional groups,
 * `:"quoted"` names, and `*name` named wildcards; Express 4 (path-to-regexp 0.x) treats `{}` as
 * literal characters, `*` as an unnamed wildcard, and bare `?`/`+`/`(` as string-pattern regex
 * (which we cannot safely normalize → null). Returns null for syntax we cannot represent.
 * @param {string} route
 * @param {boolean} isV5
 * @returns {{ tokens: RouteToken[], groupParent: Map<number, number> } | null}
 */
function parseRoute (route, isV5 = true) {
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
    if (c === '\\') {
      // Backslash-escape: the next char is a literal static char (incl. reserved {}()).
      if (i + 1 < route.length) {
        staticBuf += route[i + 1]
        i += 2
      } else {
        staticBuf += '\\'
        i++
      }
    } else if (c === '{' && isV5) {
      flush()
      nextGroupId++
      groupParent.set(nextGroupId, groupStack[groupStack.length - 1])
      groupStack.push(nextGroupId)
      i++
    } else if (c === '}' && isV5) {
      flush()
      if (groupStack.length === 1) return null // unbalanced
      groupStack.pop()
      i++
    } else if (!isV5 && (c === '?' || c === '+')) {
      // Express 4 string-pattern regex outside a :param — cannot be safely normalized.
      return null
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
          } else if (
            prev.type === 'static' && prev.group === currentGroup &&
            prev.text[prev.text.length - 1] === '.'
          ) {
            // path-to-regexp treats only a single delimiter char ('.') before the param as part
            // of the optional prefix; ordinary preceding static (e.g. the 'x' in '/x:id?') stays
            // mandatory, so the param alone is optional.
            prev.text = prev.text.slice(0, -1)
            tokens.splice(-1, 0, { type: 'static', text: '.', group: gN })
            if (prev.text === '') tokens.splice(-3, 1)
          }
        }
      } else {
        tokens.push({ type: 'param', name: nm.name, group: currentGroup, constraint })
      }
    } else if (c === '*') {
      flush()
      // Express 5: `*name` is a named wildcard. Express 4: `*` is an unnamed wildcard (any name
      // chars after it are ordinary static text).
      const nm = isV5 ? parseName(route, i + 1) : null
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
 * @param {boolean} [isV5] - parse with Express 5 dialect (default true)
 * @returns {CompiledRoute | null}
 */
function compileRoute (route, isV5 = true) {
  if (route.charAt(0) === '(') return null // RegExp route, stored as "(/.../flags)"

  const parsed = parseRoute(route, isV5)
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

  // A param whose inline constraint can match a '/' spans multiple URL segments. In the route's
  // tail it is effectively a catch-all (convert it so the matcher consumes the rest); anywhere
  // else it breaks the one-segment-one-element rule, so omit rather than guess.
  for (let s = 0; s < cleaned.length; s++) {
    const toks = cleaned[s].tokens
    for (let k = 0; k < toks.length; k++) {
      const t = toks[k]
      if (t.type === 'param' && constraintMatchesSlash(t.constraint)) {
        if (s !== cleaned.length - 1) return null
        toks[k] = { type: 'wildcard', name: t.name, group: t.group, zeroOrMore: true }
      }
    }
  }

  const optionalGroups = []
  for (const [id] of groupParent) optionalGroups.push(id)
  optionalGroups.sort((a, b) => a - b)

  // Guard against pathological routes: too many optional groups makes the presence bitmask
  // (1 << i) overflow 32 bits and the backtracking matcher blow up. Omit rather than risk a
  // wrong (aliased) cached result or an event-loop stall.
  if (optionalGroups.length > MAX_OPTIONAL_GROUPS) return null

  // Which optional groups carry a named param (→ resolvable from req.params) and which do not
  // (static-only or wildcard-only → only the URL can tell whether they are present).
  const optionalParamNames = []
  const paramBearingGroups = new Set()
  for (const seg of cleaned) {
    for (const t of seg.tokens) {
      if (t.group !== 0 && t.type === 'param' && t.name != null) {
        optionalParamNames.push(t.name)
        paramBearingGroups.add(t.group)
      }
    }
  }
  const hasGroupNeedingUrl = optionalGroups.some(g => !paramBearingGroups.has(g))

  const compiled = {
    segments: cleaned,
    groupParent,
    optionalGroups,
    trailingSlash,
    precomputed: null,
    optionalParamNames,
    hasGroupNeedingUrl,
  }

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
    if (g === undefined || !present.has(g)) return false
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
      // Catch-all is terminal (rule 5). A static prefix is subsumed into the single element, but
      // any preceding dynamic params in the same segment are combined with it via '+'.
      out.push(`{${paramNames.join('+')}}`)
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
 * Build (and cache) a regex that matches a single URL segment against a route segment, plus the
 * list of intra-segment optional group ids (each has a named marker capture in the regex).
 *
 * Tokens at the segment's base group are mandatory; tokens in a deeper (optional) group are
 * wrapped in an optional non-capturing group with a named marker capture (?<_ddgN>) so we can
 * detect whether that group matched by name (robust to capture-index shifts from constraints).
 *
 * @param {RouteSegment} seg
 * @param {Map<number, number>} groupParent
 * @returns {{ regex: RegExp, presence: number[] }}
 */
function getSegmentMatcher (seg, groupParent) {
  const cached = segmentRegexCache.get(seg)
  if (cached !== undefined) return cached

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
    // (m.groups), so it is immune to capture-index shifts from capturing groups inside an inline
    // constraint (e.g. ':id(fo(o)).:format?').
    if (intraOptional && openGroup === 0) {
      pattern += `(?:(?<${markerName(t.group)}>)` // empty marker: defined iff this group matched
      presence.push(t.group)
      openGroup = t.group
    }

    if (t.type === 'static') {
      // Match against the encoded form so non-ASCII static optionals match the (percent-encoded)
      // request URL, e.g. route 'café' vs URL segment 'caf%C3%A9'.
      pattern += escapeRegex(encodeStaticSegment(t.text))
    } else if (t.type === 'param') {
      // Always a generic, lazy single-segment matcher — developer inline constraints are NEVER
      // embedded here, so an attacker-controlled URL can never trigger catastrophic backtracking
      // (ReDoS) in a developer-authored regex. The constraint value is discarded from the output
      // anyway; req.params is the authority for which optional params are present (see
      // normalizeRouteExpress), so the small loss of constraint-based disambiguation is acceptable.
      pattern += '[^/]+?'
    } else { // wildcard inside a single-segment match (rare); match the rest of the segment
      pattern += '[^/]*'
    }
  }
  if (openGroup !== 0) pattern += ')?'

  let result
  try {
    // Case-insensitive: Express routing is case-insensitive by default, so static segments must
    // match regardless of case. The normalized OUTPUT still preserves the route's declared case.
    result = { regex: new RegExp('^' + pattern + '$', 'i'), presence }
  } catch {
    // Last-resort fallback (should not happen: fragments are pre-validated). Use a generic
    // single-segment match with no presence markers so the read side never dereferences a
    // missing named group.
    result = { regex: /^[^/]+$/, presence: [] }
  }
  segmentRegexCache.set(seg, result)
  return result
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
 * True when an inline constraint can match a string containing '/', i.e. the param may span
 * multiple URL segments (e.g. `(.+)`, `(.*)`, `([^x]+)`).
 * @param {string|undefined} src
 * @returns {boolean}
 */
function constraintMatchesSlash (src) {
  if (!isValidRegex(src)) return false
  // A literal '/' in the source (outside an escape) means the param can span segments.
  if (src.replaceAll(/\\./g, '').includes('/')) return true
  try {
    const re = new RegExp(`^(?:${src})$`)
    return re.test('a/b') || re.test('a/b/c') || re.test('/')
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
  matchStepsRemaining = MAX_MATCH_STEPS
  const matched = matchSegments(compiled, 0, urlSegs, 0, present)
  return { present: matched ? present : null, aborted: matchStepsRemaining < 0 }
}

// Step budget for the current matchSegments traversal. Safe as module state because presence
// resolution is synchronous and non-reentrant (each request resolves fully before the next).
let matchStepsRemaining = MAX_MATCH_STEPS

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
    const wIdx = seg.tokens.indexOf(wildcard)
    // Any tokens before the wildcard in the same segment (e.g. ':a-' in ':a-*') must match the
    // start of the current URL segment before the wildcard consumes the remainder.
    if (wIdx > 0) {
      if (ui >= urlSegs.length) return false
      let pfx = ''
      for (let k = 0; k < wIdx; k++) {
        const t = seg.tokens[k]
        pfx += t.type === 'static' ? escapeRegex(encodeStaticSegment(t.text)) : '[^/]+?'
      }
      if (!new RegExp('^' + pfx, 'i').test(urlSegs[ui])) return false
    }
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
  const { regex, presence } = getSegmentMatcher(seg, compiled.groupParent)
  const m = regex.exec(urlSegs[ui])
  if (!m) return false

  const added = []
  for (const groupId of presence) {
    if (m.groups?.[markerName(groupId)] !== undefined) {
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
 * @param {boolean} [isV5] - parse with Express 5 dialect (default true)
 * @returns {string|null} Normalized route, or null when normalization is not possible
 */
function normalizeRouteExpress (route, params, urlPath, isV5 = true) {
  if (typeof route !== 'string' || !route) return null

  // Cache key includes the dialect: the same route string parses differently in v4 vs v5.
  const cacheKey = (isV5 ? '5:' : '4:') + route
  let entry = routeCache.get(cacheKey)
  if (entry === undefined) {
    entry = compileRoute(route, isV5)
    routeCache.set(cacheKey, entry)
  }
  if (entry === null) return null

  // No optional groups → fixed result (computed once at compile time).
  if (entry.precomputed !== null) return entry.precomputed

  // Resolve which optional groups are present. req.params is the authority: when it already
  // determines every optional param (and there are no static/wildcard-only optional groups that
  // only the URL can resolve), trust it directly. Otherwise use the URL — which also recovers
  // params dropped by mergeParams=false sub-routers.
  const paramsHasOptional = entry.optionalParamNames.some(
    n => params != null && Object.hasOwn(params, n) && params[n]
  )
  let present
  if (paramsHasOptional && !entry.hasGroupNeedingUrl) {
    present = resolvePresenceFromParams(entry, params)
  } else if (urlPath) {
    const urlSegs = urlPath.split('/').filter(Boolean)
    const { present: urlPresent, aborted } = resolvePresenceFromUrl(entry, urlSegs)
    // On step-budget abort the result is unknown — fall back to the (safe, bounded) req.params
    // resolution rather than guessing from a half-finished match. A clean URL mismatch (no
    // aborted, urlPresent null) likewise falls back to params.
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
  const component = web.root(req)?.context()?.getTag?.('component')

  // eslint-disable-next-line sonarjs/no-small-switch
  switch (component) {
    case 'express': {
      const context = web.getContext(req)
      const paths = context?.paths
      const route = paths && (paths.length > 1 ? paths.join('') : paths[0])
      const raw = req.originalUrl || req.url
      const qIdx = raw ? raw.indexOf('?') : -1
      const urlPath = qIdx === -1 ? raw : raw.slice(0, qIdx)
      // Default to the Express 5 dialect when the major version is unknown.
      const isV5 = context?.frameworkVersion === undefined || context.frameworkVersion >= 5
      return normalizeRouteExpress(route, req.params, urlPath, isV5)
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
