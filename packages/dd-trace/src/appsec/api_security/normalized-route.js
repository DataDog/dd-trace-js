'use strict'

const { HTTP_ROUTE } = require('../../../../../ext/tags')
const web = require('../../plugins/util/web')
const { getParse, getMatch } = require('../../../../datadog-instrumentations/src/path-to-regexp')

/**
 * Normalize an HTTP route to the _dd.appsec.normalized_route format.
 *
 * Rules: (1) starts with /, ends with / only when the effective route does; (2) no empty elements;
 * (3) static text keeps [A-Za-z0-9.-~_], other chars percent-encoded (UTF-8, valid %XX kept);
 * (4) each present param renders as {name} in place, so a segment keeps its static text and several
 * params stay separate ('/photos/{id}.{format}'); (5) names are limited to [A-Za-z0-9_], collisions
 * get the smallest free _N suffix; (6) optional groups and catch-alls (always optional) are resolved
 * per request.
 *
 * Design: Express 5 / path-to-regexp 8 only. The route is parsed once by path-to-regexp's `parse()`
 * (token tree → segment templates, cached per route string). path-to-regexp compiles a route into
 * alternatives (each optional group included, then excluded) and Express takes the first that
 * matches, so matching each alternative in that order with path-to-regexp's own `match()` tells
 * which groups the served request had. Without a usable URL match, presence falls back to
 * req.params. Express 4 ships path-to-regexp 0.x, which has no `parse()` → no tag.
 */

// Alternatives double with each optional group (path-to-regexp itself refuses more than 256), so
// routes with more optional groups resolve presence from req.params only.
const MAX_OPTIONAL_GROUPS = 8

// Rendered outputs cached per route; presence masks depend on the request, so bound them.
const MAX_CACHED_VARIANTS = 64

// Keyed on the raw route string — bounded by declared routes (never attacker URLs), so it retains
// for the process lifetime.
const routeCache = new Map()

const EMPTY_SET = new Set()

// Keyed on mount-prefix strings, bounded by declared mounts.
const prefixCache = new Map()

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
 * @typedef {{ tokens: PathToRegexpToken[], segments: RouteSegment[],
 *   groupParent: Map<number, number>, optionalGroups: number[], wildcards: RouteToken[],
 *   nameCount: Map<string, number>, precomputed: string | null, branches: RouteBranch[] | null,
 *   variants?: Map<number, string> }} CompiledRoute
 *
 * @typedef {{ sensitive?: boolean, strict?: boolean }} RoutingOptions
 *
 * @typedef {(tokens: PathToRegexpToken[], options: { sensitive: boolean, trailing: boolean })
 *   => ((url: string) => object | undefined) | undefined} MatcherFactory
 */

/**
 * Convert path-to-regexp's nested token tree into a flat segment model. Text tokens split on '/'
 * into slash + static tokens; each `{...}` group gets a fresh id (parent tracked in groupParent,
 * id in groupIds), its inner tokens inherit it.
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

  const compiled = {
    tokens: parsed.tokens,
    segments,
    groupParent,
    optionalGroups: [...groupParent.keys()],
    wildcards,
    nameCount,
    precomputed: null,
    branches: null,
  }

  // No optional groups → fixed output, computed once.
  if (compiled.optionalGroups.length === 0) {
    compiled.precomputed = renderRoute(compiled, EMPTY_SET)
    return compiled
  }

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
 * URL-encode chars outside the static alphabet [A-Za-z0-9.-~_]. A valid %XX escape is kept (hex
 * uppercased): Express matches route text against the still-encoded URL. The 'u' flag iterates whole
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
  // '.json' in '/x{/:id}.json' survives when :id is absent). The route ends with '/' when a present
  // slash is the last thing rendered.
  const out = []
  let current = ''
  let dynPtr = 0
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
 * Which optional groups are present, from req.params: a group is present iff one of its uniquely
 * named param tokens has a non-empty own-property value (a shared name can't be attributed). Marks
 * ancestor groups present too; groups without such a param (static-only) are absent.
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
 * Normalize an Express route string. Express 5 only: `parse`/`makeMatcher` are path-to-regexp 8's
 * `parse()` and a `match()` factory; returns null when either is unavailable (Express 4).
 * @param {string} route - route string (the http.route value)
 * @param {object|null|undefined} params - req.params (fallback when the URL doesn't match)
 * @param {string|undefined} urlPath - request URL (query stripped here)
 * @param {(pattern: string) => { tokens: PathToRegexpToken[] } | undefined} parse
 * @param {MatcherFactory} makeMatcher
 * @param {RoutingOptions} [options] - options of the Router that owns the served route
 */
function normalizeRouteExpress (route, params, urlPath, parse, makeMatcher, options = {}) {
  if (typeof route !== 'string' || !route || typeof parse !== 'function' || typeof makeMatcher !== 'function') {
    return null
  }

  let entry = routeCache.get(route)
  if (entry === undefined) {
    entry = compileRoute(route, parse)
    routeCache.set(route, entry)
  }
  if (entry === null) return null
  if (entry.precomputed !== null) return entry.precomputed

  // The matched URL is authoritative (handles mergeParams=false sub-routers); fall back to
  // req.params when there is no URL, it doesn't match, or the route can't be matched.
  let present
  if (urlPath && entry.branches !== null) {
    const qIdx = urlPath.indexOf('?')
    present = matchPresence(entry, qIdx === -1 ? urlPath : urlPath.slice(0, qIdx), makeMatcher, options)
  }
  present ??= resolvePresence(entry, params)

  // The bitmask key holds 31 groups; render larger routes without the cache.
  if (entry.optionalGroups.length > 31) return renderRoute(entry, present)

  const mask = presenceBitmask(entry.optionalGroups, present)
  const cached = entry.variants.get(mask)
  if (cached !== undefined) return cached

  const result = renderRoute(entry, present)
  if (entry.variants.size < MAX_CACHED_VARIANTS) entry.variants.set(mask, result)
  return result
}

/**
 * True when the URL can be matched with the served route's options: `route` is the single-string
 * `leafPath` under a static mount prefix (text only, or none). A dynamic parent mount matches with
 * its own options and strips its part of the URL, which the leaf options can't reproduce.
 * @param {string} route - joined route (http.route)
 * @param {unknown} leafPath - path of the served route (`req.route.path`)
 * @param {(pattern: string) => { tokens: PathToRegexpToken[] } | undefined} parse
 */
function canMatchUrl (route, leafPath, parse) {
  if (typeof leafPath !== 'string') return false
  let prefix
  if (route.endsWith(leafPath)) {
    prefix = route.slice(0, route.length - leafPath.length)
  } else if (leafPath === '/') {
    prefix = route // the router plugin leaves a mounted '/' out of http.route
  } else {
    return false
  }
  if (prefix === '') return true

  let result = prefixCache.get(prefix)
  if (result === undefined) {
    const tokens = parse(prefix)?.tokens
    result = tokens !== undefined && tokens.every(token => token.type === 'text')
    prefixCache.set(prefix, result)
  }
  return result
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
      // Unknown Router options (route registered while AppSec was off) can't reproduce the match.
      const options = routeOptions.get(req.route)
      const urlPath = options !== undefined && typeof route === 'string' && canMatchUrl(route, req.route.path, parse)
        ? req.originalUrl || req.url
        : undefined
      return normalizeRouteExpress(route, req.params, urlPath, parse, makeMatcher, options)
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
