'use strict'

const { getParse, getMatch } = require('../../../../../datadog-instrumentations/src/path-to-regexp')

const { renderRoute, isEmptyValue, segmentsFromTokens } = require('./renderer')

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
 * groups is resolved with path-to-regexp's own `match()` — we do not re-implement matching. As in
 * Express, the mount prefix matches the start of the URL, with the app Router's case sensitivity, and
 * the served route the rest, with its own Router's options; each tries its alternatives in
 * path-to-regexp's order (group included, then excluded), else req.params is used. Express 4 ships
 * path-to-regexp 0.x, which has no `parse()` → no tag.
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
 * @typedef {{ sensitive?: boolean, strict?: boolean, end?: boolean }} RoutingOptions - `end: false` for a mount
 *
 * @typedef {{ route: string, options: RoutingOptions }} MatchedPart
 *   A part of the route and the options of the Router layer that matched it.
 *
 * @typedef {(tokens: PathToRegexpToken[], options: { sensitive: boolean, trailing: boolean, end: boolean })
 *   => ((url: string) => { path: string, params: object } | undefined) | undefined} MatcherFactory
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

  return { ...segmentsFromTokens(flat, groupParent), groupIds }
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

  // match()'s regexp is exponential in the route's TOTAL optional-group count (static and structural
  // groups included, not just the resolvable ones), so cap that before building the matcher. A route
  // without groups still gets its single branch: as a mount, it must match to consume its part.
  if (groupIds.size <= MAX_OPTIONAL_GROUPS) {
    compiled.branches = expandBranches(parsed.tokens, groupIds).map(branch => ({ ...branch, matchers: [] }))
  }

  // No optional groups → fixed output, computed once.
  if (optionalGroups.length === 0) {
    compiled.precomputed = renderRoute(compiled, EMPTY_SET)
    return compiled
  }
  compiled.variants = new Map()
  return compiled
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
 * served), with the matched path, or undefined when none can be matched. A catch-all is present
 * unless it captured only slashes, or when another token of that alternative shares its name (its
 * value can't be told apart).
 * @param {CompiledRoute} compiled
 * @param {string} path - request path, query stripped
 * @param {MatcherFactory} makeMatcher
 * @param {RoutingOptions} options
 * @returns {{ present: Set<number>, path: string } | undefined}
 */
function matchPresence (compiled, path, makeMatcher, options) {
  const sensitive = options.sensitive === true
  const strict = options.strict === true
  const end = options.end !== false
  const key = (sensitive ? 1 : 0) | (strict ? 2 : 0) | (end ? 0 : 4)
  for (const branch of compiled.branches) {
    let matcher = branch.matchers[key]
    if (matcher === undefined) {
      // Like Express's router, a non-strict route matches without its trailing slashes.
      let { tokens } = branch
      const last = compiled.tokens.at(-1)
      if (!strict && last?.type === 'text' && last.value.endsWith('/')) {
        let end = last.value.length
        while (end > 0 && last.value[end - 1] === '/') end--
        tokens = [...tokens.slice(0, -1), { type: 'text', value: last.value.slice(0, end) }]
      }
      matcher = makeMatcher(tokens, { sensitive, trailing: !strict, end })
      if (matcher === undefined) return
      branch.matchers[key] = matcher
    }
    const match = matcher(path)
    if (match === undefined) continue

    const { params } = match
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
    return { present, path: match.path }
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
 * Which optional groups of the joined route are present, from its parts matched in sequence against
 * the path as Express routed it: a mount consumes the start, the next part matches the rest. Undefined
 * when a part doesn't match. A part's group ids follow those of the parts before it.
 * @param {MatchedPart[]} parts
 * @param {string} path - request path, query stripped
 * @param {(pattern: string) => { tokens: PathToRegexpToken[] } | undefined} parse
 * @param {MatcherFactory} makeMatcher
 * @returns {Set<number> | undefined}
 */
function matchParts (parts, path, parse, makeMatcher) {
  const present = new Set()
  let offset = 0
  for (const { route, options } of parts) {
    const compiled = getCompiledRoute(route, parse)
    if (compiled === null || compiled.branches === null) return

    const matched = matchPresence(compiled, path, makeMatcher, options)
    if (matched === undefined) return
    for (const group of matched.present) present.add(group + offset)
    offset += compiled.optionalGroups.length
    path = path.slice(matched.path.length) || '/'
  }
  return present
}

/**
 * Normalize an Express route string. Express 5 only: `parse`/`makeMatcher` are path-to-regexp 8's
 * `parse()` and a `match()` factory; returns null when either is unavailable (Express 4).
 * @param {string} route - route string (the http.route value)
 * @param {object|null|undefined} params - req.params (fallback when the URL doesn't match)
 * @param {string|undefined} urlPath - request URL (query stripped here)
 * @param {(pattern: string) => { tokens: PathToRegexpToken[] } | undefined} parse
 * @param {MatcherFactory} makeMatcher
 * @param {MatchedPart[]} [parts] - the route's parts, in order, as its Routers matched them
 */
function normalizeRoute (route, params, urlPath, parse, makeMatcher, parts) {
  if (typeof route !== 'string' || !route || typeof parse !== 'function' || typeof makeMatcher !== 'function') {
    return null
  }

  const entry = getCompiledRoute(route, parse)
  if (entry === null) return null
  if (entry.precomputed !== null) return entry.precomputed

  // The matched URL is authoritative (it keeps mount params that mergeParams=false drops); fall back
  // to req.params when the route can't be split or the URL doesn't match.
  let present
  if (urlPath && parts !== undefined) {
    const qIdx = urlPath.indexOf('?')
    present = matchParts(parts, qIdx === -1 ? urlPath : urlPath.slice(0, qIdx), parse, makeMatcher)
  }
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
 * Split the route where Express matched it: the mount prefix, with the app Router's case
 * sensitivity, then the served route, with its own Router's options. Only route patterns and options
 * are read: Express restores `req.url`/`req.baseUrl` once a request leaves a Router (e.g. to an app
 * error handler). Undefined when the served Router's options are unknown (route registered while
 * AppSec was off) or the route can't be split (a route array). A nested Router's own case
 * sensitivity is not tracked per mount, so its mount matches with the app's: only alternatives
 * differing by letter case can then resolve differently.
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

  const served = { route: leaf, options }
  if (prefix === '') return [served]
  // Mounts are never strict and match the start of the path.
  const mount = { sensitive: req.app?.router?.caseSensitive === true, end: false }
  return [{ route: prefix, options: mount }, served]
}

/**
 * Normalize a request with the serving Express app's grammar and Router options.
 * @param {object} req
 * @param {string | undefined} route
 */
function normalizeRequest (req, route) {
  // Express 5 removed app.del; the serving app distinguishes mixed-major processes.
  if (typeof req.app?.del === 'function') return null
  return normalizeRoute(route, req.params, req.originalUrl || req.url, getParse(), getMatch(),
    splitRoute(req, route))
}

/**
 * Record the options of the Router that registered a Route (published by the router instrumentation).
 * @param {{ route: object, sensitive: boolean, strict: boolean }} message
 */
function onRouteCreate ({ route, sensitive, strict }) {
  routeOptions.set(route, { sensitive, strict })
}

module.exports = { normalizeRoute, normalizeRequest, onRouteCreate }
