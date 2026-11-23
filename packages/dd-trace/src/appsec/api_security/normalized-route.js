'use strict'

const { HTTP_ROUTE } = require('../../../../../ext/tags')
const web = require('../../plugins/util/web')
const { getParse, getMatch } = require('../../../../datadog-instrumentations/src/path-to-regexp')

/**
 * Normalize an HTTP route to the _dd.appsec.normalized_route format.
 *
 * Rules: (1) starts with /, trailing slash only if declared; (2) no empty elements; (3) static
 * segments keep [A-Za-z0-9.-~_], other chars percent-encoded (UTF-8); (4) dynamic params render as
 * {name}, names limited to [A-Za-z0-9_] with an _N suffix on collision; (5) a segment keeps its static
 * text and each param in place ('/photos/{id}.{format}'); (6) optional groups and catch-alls are
 * resolved per request against the matched URL.
 *
 * Design: Express 5 / path-to-regexp 8 only. The route is parsed once by path-to-regexp's `parse()`
 * (token tree → segment templates, cached per route string). Per-request presence of optional
 * groups is resolved with path-to-regexp's own `match()` — we do not re-implement matching. The
 * mount prefix and the served route are each matched where Express matched them (`req.baseUrl`,
 * `req.url`), each alternative in path-to-regexp's order (group included, then excluded), else
 * req.params is used. Express 4 ships path-to-regexp 0.x, which has no `parse()` → no tag.
 */

// path-to-regexp's match() builds a regexp exponential in a route's optional-group count, so cap it;
// a part with more optional groups resolves presence from req.params, a route with more skips the
// render cache.
const MAX_OPTIONAL_GROUPS = 8

// Rendered outputs cached per route; presence masks depend on the request, so bound them.
const MAX_CACHED_VARIANTS = 64

// Keyed on the raw route string — bounded by declared routes (never attacker URLs), so it retains
// for the process lifetime.
const routeCache = new Map()

const EMPTY_SET = new Set()

/** @type {WeakMap<object, RoutingOptions>} options of the Router that registered each Route */
const routeOptions = new WeakMap()

/**
 * @typedef {{ type: 'slash', group: number }
 *   | { type: 'static', text: string, group: number }
 *   | { type: 'param', name: string, group: number }
 *   | { type: 'wildcard', name: string, group: number }} RouteToken
 *
 * `group` is the id of the innermost enclosing optional `{...}` group (0 = top-level, always present).
 * A wildcard gets its own group: a catch-all is always optional.
 *
 * @typedef {{ group: number, tokens: RouteToken[] }} RouteSegment
 *
 * @typedef {{ type: 'text', value: string } | { type: 'param', name: string }
 *   | { type: 'wildcard', name: string } | { type: 'group', tokens: PathToRegexpToken[] }} PathToRegexpToken
 *
 * @typedef {{ tokens: PathToRegexpToken[], groups: number[],
 *   matchers: Array<((url: string) => object | undefined) | undefined> }} RouteBranch
 *
 * @typedef {{ segments: RouteSegment[], groupParent: Map<number, number>, optionalGroups: number[],
 *   tokens: PathToRegexpToken[], wildcards: RouteToken[], nameCount: Map<string, number>,
 *   precomputed: string | null, branches: RouteBranch[] | null,
 *   variants?: Map<number, string> }} CompiledRoute
 *
 * @typedef {{ sensitive?: boolean, strict?: boolean }} RoutingOptions
 *
 * @typedef {{ route: string, url: string, options: RoutingOptions }} MatchedPart
 *   A part of the route and the request path its Router matched it against.
 *
 * @typedef {(tokens: PathToRegexpToken[], options: { sensitive: boolean, trailing: boolean })
 *   => ((url: string) => object | undefined) | undefined} MatcherFactory
 */

/**
 * Convert path-to-regexp's nested token tree into a flat segment model. Text tokens split on '/'
 * into slash + static tokens; each `{...}` group gets a fresh id (parent tracked in groupParent),
 * its inner tokens inherit it (groupIds maps each group token to its id).
 * @param {PathToRegexpToken[]} ptTokens
 * @returns {{ segments: RouteSegment[], groupParent: Map<number, number>,
 *   groupIds: Map<PathToRegexpToken, number> }}
 */
function tokensToSegments (ptTokens) {
  const groupParent = new Map()
  const groupIds = new Map()
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
        nextGroupId++
        groupParent.set(nextGroupId, group)
        flat.push({ type: 'wildcard', name: token.name, group: nextGroupId })
      } else if (token.type === 'group') {
        nextGroupId++
        const groupId = nextGroupId
        groupParent.set(groupId, group)
        groupIds.set(token, groupId)
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

  return { segments, groupParent, groupIds }
}

/**
 * List the route's alternatives in path-to-regexp's order (each group included, then excluded,
 * earlier groups varying slowest), each with its flat tokens and the ids of its included groups.
 * @param {PathToRegexpToken[]} tokens
 * @param {Map<PathToRegexpToken, number>} groupIds
 * @returns {Array<{ tokens: PathToRegexpToken[], groups: number[] }>}
 */
function expandBranches (tokens, groupIds) {
  let branches = [{ tokens: [], groups: [] }]
  for (const token of tokens) {
    const choices = token.type === 'group'
      ? [...expandBranches(token.tokens, groupIds).map(inner => ({
          tokens: inner.tokens,
          groups: [groupIds.get(token), ...inner.groups],
        })), { tokens: [], groups: [] }]
      : [{ tokens: [token], groups: [] }]
    branches = branches.flatMap(branch => choices.map(choice => ({
      tokens: [...branch.tokens, ...choice.tokens],
      groups: [...branch.groups, ...choice.groups],
    })))
  }
  return branches
}

/**
 * Compile a raw route string into a CompiledRoute, or null when unsupported.
 * @param {string} route
 * @param {(pattern: string) => { tokens: PathToRegexpToken[] } | undefined} parse
 * @returns {CompiledRoute | null}
 */
function compileRoute (route, parse) {
  const parsed = parse(route)
  if (!Array.isArray(parsed?.tokens)) return null

  const { segments, groupParent, groupIds } = tokensToSegments(parsed.tokens)

  const nameCount = new Map()
  const wildcards = []
  for (const seg of segments) {
    for (const t of seg.tokens) {
      if (t.type === 'static') continue
      nameCount.set(t.name, (nameCount.get(t.name) ?? 0) + 1)
      if (t.type === 'wildcard') wildcards.push(t)
    }
  }

  const optionalGroups = [...groupParent.keys()]

  const compiled = {
    segments,
    groupParent,
    optionalGroups,
    tokens: parsed.tokens,
    wildcards,
    nameCount,
    precomputed: null,
    branches: null,
  }

  // No optional groups → fixed output, computed once (no matcher, so group count is irrelevant here).
  if (optionalGroups.length === 0) {
    compiled.precomputed = renderRoute(compiled, EMPTY_SET)
    return compiled
  }

  // match()'s regexp is exponential in the route's TOTAL optional-group count (static and structural
  // groups included, not just the resolvable ones), so cap that before building the matcher.
  if (groupIds.size <= MAX_OPTIONAL_GROUPS) {
    compiled.branches = expandBranches(parsed.tokens, groupIds).map(branch => ({ ...branch, matchers: [] }))
  }
  compiled.variants = new Map()
  return compiled
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
    g = groupParent.get(g)
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
 * @param {CompiledRoute} compiled
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

  // Pass 2: a valid name keeps itself at its last present occurrence (the value Express exposes);
  // every other token takes its sanitized name if free, else the smallest free _N suffix.
  const sanitized = dyn.map(t => t.name.replaceAll(/[^A-Za-z0-9_]/gu, '_'))
  const lastIndexByName = new Map()
  for (let idx = 0; idx < dyn.length; idx++) {
    if (sanitized[idx] === dyn[idx].name) lastIndexByName.set(dyn[idx].name, idx)
  }
  const used = new Set(lastIndexByName.keys())
  const resolvedNames = new Array(dyn.length)
  for (let idx = 0; idx < dyn.length; idx++) {
    let name = dyn[idx].name
    if (lastIndexByName.get(name) !== idx) {
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

/**
 * Which optional groups are present, from a captured/params object: an optional group is present iff
 * one of its uniquely named param tokens has a non-empty own-property value. Marks ancestor groups present too.
 * @param {CompiledRoute} compiled
 * @param {object | null | undefined} params
 * @returns {Set<number>}
 */
function resolvePresence (compiled, params) {
  const present = new Set()
  if (params == null) return present
  const { segments, groupParent, nameCount } = compiled
  for (const seg of segments) {
    for (const t of seg.tokens) {
      if (t.group === 0 || t.type === 'static' || nameCount.get(t.name) > 1) continue
      if (Object.hasOwn(params, t.name) && !isEmptyValue(params[t.name], t.type === 'wildcard')) {
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
 * Which optional groups are present, from the first alternative matching the URL (the one Express
 * served), or undefined when none can be matched. A catch-all is present unless it captured only
 * slashes, or when another token of that alternative shares its name (its value can't be told apart).
 * @param {CompiledRoute} compiled
 * @param {string} path - request path, query stripped
 * @param {MatcherFactory} makeMatcher
 * @param {RoutingOptions} options
 * @returns {Set<number> | undefined}
 */
function matchPresence (compiled, path, makeMatcher, options) {
  const sensitive = options.sensitive === true
  const strict = options.strict === true
  const key = (sensitive ? 1 : 0) | (strict ? 2 : 0)
  for (const branch of compiled.branches) {
    let matcher = branch.matchers[key]
    if (matcher === undefined) {
      // Like Express's router, a non-strict route matches without its trailing slashes.
      let { tokens } = branch
      const last = compiled.tokens.at(-1)
      if (!strict && last.type === 'text' && last.value.endsWith('/')) {
        let end = last.value.length
        while (end > 0 && last.value[end - 1] === '/') end--
        tokens = [...tokens.slice(0, -1), { type: 'text', value: last.value.slice(0, end) }]
      }
      matcher = makeMatcher(tokens, { sensitive, trailing: !strict })
      if (matcher === undefined) return
      branch.matchers[key] = matcher
    }
    const params = matcher(path)
    if (params === undefined) continue

    const present = new Set(branch.groups)
    for (const t of compiled.wildcards) {
      let shared = false
      if (compiled.nameCount.get(t.name) > 1) {
        let count = 0
        for (const other of branch.tokens) {
          if (other.type !== 'text' && other.name === t.name && ++count === 2) {
            shared = true
            break
          }
        }
      }
      if (shared || !isEmptyValue(params[t.name], true)) present.add(t.group)
    }
    return present
  }
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
 * @param {string} route
 * @param {(pattern: string) => { tokens: PathToRegexpToken[] } | undefined} parse
 */
function getCompiledRoute (route, parse) {
  let entry = routeCache.get(route)
  if (entry === undefined) {
    entry = compileRoute(route, parse)
    routeCache.set(route, entry)
  }
  return entry
}

/**
 * Which optional groups of the joined route are present, from each part matched against its own
 * request path, or undefined when a part can't be matched. A part's group ids follow those of the
 * parts before it, as in the joined route.
 * @param {MatchedPart[]} parts
 * @param {(pattern: string) => { tokens: PathToRegexpToken[] } | undefined} parse
 * @param {MatcherFactory} makeMatcher
 * @returns {Set<number> | undefined}
 */
function matchParts (parts, parse, makeMatcher) {
  const present = new Set()
  let offset = 0
  for (const { route, url, options } of parts) {
    const compiled = getCompiledRoute(route, parse)
    if (compiled === null) return
    if (compiled.precomputed !== null) continue // no optional groups (an empty prefix included)
    if (compiled.branches === null) return

    const qIdx = url.indexOf('?')
    const matched = matchPresence(compiled, qIdx === -1 ? url : url.slice(0, qIdx), makeMatcher, options)
    if (matched === undefined) return
    for (const group of matched) present.add(group + offset)
    offset += compiled.optionalGroups.length
  }
  return present
}

/**
 * Normalize an Express route string. Express 5 only: `parse`/`makeMatcher` are path-to-regexp 8's
 * `parse()` and a `match()` factory; returns null when either is unavailable (Express 4).
 * @param {string} route - route string (the http.route value)
 * @param {object|null|undefined} params - req.params (fallback when the route parts don't match)
 * @param {MatchedPart[]|undefined} parts - the route's parts, in order, as its Routers matched them
 * @param {(pattern: string) => { tokens: PathToRegexpToken[] } | undefined} parse
 * @param {MatcherFactory} makeMatcher
 */
function normalizeRouteExpress (route, params, parts, parse, makeMatcher) {
  if (typeof route !== 'string' || !route || typeof parse !== 'function' || typeof makeMatcher !== 'function') {
    return null
  }

  const entry = getCompiledRoute(route, parse)
  if (entry === null) return null
  if (entry.precomputed !== null) return entry.precomputed

  // The matched parts are authoritative (they keep mount params that mergeParams=false drops);
  // fall back to req.params when the route can't be split or a part doesn't match.
  let present
  if (parts !== undefined) present = matchParts(parts, parse, makeMatcher)
  present ??= resolvePresence(entry, params)

  if (entry.optionalGroups.length > MAX_OPTIONAL_GROUPS) return renderRoute(entry, present)

  const mask = presenceBitmask(entry.optionalGroups, present)
  const cached = entry.variants.get(mask)
  if (cached !== undefined) return cached

  const result = renderRoute(entry, present)
  if (entry.variants.size < MAX_CACHED_VARIANTS) entry.variants.set(mask, result)
  return result
}

/**
 * Split the route where Express matched it: the mount prefix against `req.baseUrl` with the app
 * Router's case sensitivity, the served route against the Router-relative `req.url` with its own
 * Router's options. Undefined when those options are unknown (route registered while AppSec was
 * off) or the route can't be split (a route array).
 * @param {object} req
 * @param {unknown} route - joined route (http.route)
 * @returns {MatchedPart[] | undefined}
 */
function splitRoute (req, route) {
  const options = routeOptions.get(req.route)
  const leaf = req.route?.path
  if (options === undefined || typeof route !== 'string' || typeof leaf !== 'string') return

  let prefix
  if (route.endsWith(leaf)) {
    prefix = route.slice(0, route.length - leaf.length)
  } else if (leaf === '/') {
    prefix = route // the router plugin leaves a mounted '/' out of http.route
  } else {
    return
  }

  // Mounts are never strict.
  const mount = { sensitive: req.app?.router?.caseSensitive === true }
  return [{ route: prefix, url: req.baseUrl, options: mount }, { route: leaf, url: req.url, options }]
}

/**
 * Normalize an HTTP route from a request. Reads the framework from the span component tag.
 * @param {object} req
 */
function normalizeRoute (req) {
  const spanContext = web.root(req)?.context()
  const component = spanContext?.getTag?.('component')

  // eslint-disable-next-line sonarjs/no-small-switch
  switch (component) {
    case 'express': {
      // Routes are read as Express 5 grammar, and 4's differs ('/a{2}' matches '/aa' there), so skip
      // Express 4. Decided per request off the serving app — a process can load both majors, and the
      // parser adapters are process-wide — via the legacy `app.del` alias that Express 5 removed.
      if (typeof req.app?.del === 'function') return null

      const parse = getParse()
      const makeMatcher = getMatch()
      if (parse === undefined || makeMatcher === undefined) return null
      // Reuse the http.route tag set by web.setRouteOrEndpointTag just before this hook.
      const route = spanContext.getTag(HTTP_ROUTE)
      return normalizeRouteExpress(route, req.params, splitRoute(req, route), parse, makeMatcher)
    }
    default:
      return null
  }
}

/**
 * Record the options of the Router that registered a Route (published by the router instrumentation).
 * @param {{ route: object, sensitive: boolean, strict: boolean }} message
 */
function onRouteCreate ({ route, sensitive, strict }) {
  routeOptions.set(route, { sensitive, strict })
}

module.exports = {
  normalizeRoute,
  onRouteCreate,
  // exported for unit testing (framework-agnostic core)
  normalizeRouteExpress,
}
