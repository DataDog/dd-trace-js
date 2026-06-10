'use strict'

/**
 * Normalize an Express route string to RFC-1103 _dd.appsec.normalized_route format.
 *
 * Rules applied:
 *   1. Starts with /; trailing slash only if the route was declared with one.
 *   2. No consecutive slashes.
 *   3. Static segments: only [A-Za-z0-9.-~_]; other chars are percent-encoded.
 *   4. Dynamic params: {name}. Unnamed params get placeholder paramN (N ≥ 1,
 *      skipping any N that collides with a framework-supplied name).
 *   5. One URL segment = one atomic element. Multiple params in the same segment
 *      are combined as {a+b}. Catch-all params are a single terminal element.
 *   6. Optional params are resolved per-request using the request URL path,
 *      which correctly handles mergeParams=false sub-routers where parent-router
 *      params are absent from req.params.
 *
 * Performance design:
 *   Routes are developer-defined and repeat across every request. All route-static
 *   work (validation, splitting, segment parsing, regex compilation) is computed
 *   once and stored in routeCache. On repeated requests the hot path is:
 *     non-optional route → routeCache.get(route) → return string (~5 ns)
 *     optional route     → bitmask from resolvedParams → variants.get(bitmask) → return string
 */

// Matches Express named parameters with optional inline regex constraint and modifier.
// Groups: 1=name, 2=modifier (?|*|+)
const NAMED_PARAM_PATTERN = /:([A-Za-z0-9_]+)(?:\([^)]*\))?([?*+])?/g

// Matches Express 5 named wildcards: *name — hoisted to avoid per-iteration allocation
const NAMED_WILDCARD_RE = /^\*([A-Za-z0-9_]+)$/

// Per-segment regex cache: segment string → compiled RegExp
const segmentRegexCache = new Map()

// Per-segment params cache: segment string → parsed params array (read-only, safe to share)
const segmentParamsCache = new Map()

/**
 * Per-route result cache.
 *   null              → route is unsupported or always returns null
 *   string            → pre-computed result (route has no optional params)
 *   OptionalRouteInfo → route has optional params; variants cached by presence bitmask
 *
 * @type {Map<string, null|string|OptionalRouteInfo>}
 */
const routeCache = new Map()

/**
 * @typedef {{ optionalNames: string[], variants: Map<number,string|null>,
 *             segments: string[], namedParamNames: Set<string>, trailingSlash: boolean }} OptionalRouteInfo
 */

// ---------------------------------------------------------------------------
// Validation helpers (called once per route, results cached in routeCache)
// ---------------------------------------------------------------------------

/**
 * Return true if the route contains syntax we cannot safely normalize:
 *   - {/...} optional-group syntax (path-to-regexp v8 / Express 5)
 *   - Standalone parentheses not part of :name(regex) inline constraints
 *   - Inline constraints that contain '/' (would corrupt route.split('/'))
 *
 * Short-circuits immediately for the common case (no '(' or '{' in route).
 */
function hasUnsupportedSyntax (route) {
  if (!route.includes('(') && !route.includes('{')) return false
  const stripped = route.replaceAll(/:([A-Za-z0-9_]+)\([^)]*\)/g, ':$1')
  if (stripped.includes('{')) return true
  if (stripped.includes('(') || stripped.includes(')')) return true
  if (stripped.split('/').length !== route.split('/').length) return true
  return false
}

// ---------------------------------------------------------------------------
// Segment helpers (results per-segment cached; bounded by route count)
// ---------------------------------------------------------------------------

/**
 * Parse all named params from a single route segment (no leading slash).
 * Result is cached — callers must not mutate the returned array.
 * @param {string} seg
 * @returns {Array<{ name: string, optional: boolean, catchAll: boolean, zeroOrMore: boolean }>}
 */
function parseSegmentParams (seg) {
  const cached = segmentParamsCache.get(seg)
  if (cached !== undefined) return cached
  const params = []
  for (const m of seg.matchAll(NAMED_PARAM_PATTERN)) {
    params.push({
      name: m[1],
      optional: m[2] === '?',
      catchAll: m[2] === '*' || m[2] === '+',
      zeroOrMore: m[2] === '*',
    })
  }
  segmentParamsCache.set(seg, params)
  return params
}

/**
 * Collect all framework-supplied named parameter names in route for paramN collision avoidance.
 * Called once per route during compilation.
 * @param {string} route
 * @returns {Set<string>}
 */
function collectNamedParamNames (route) {
  const names = new Set()
  for (const m of route.matchAll(NAMED_PARAM_PATTERN)) {
    names.add(m[1])
  }
  return names
}

/**
 * Find the next paramN name that doesn't collide with existing named params.
 * @param {number} counter
 * @param {Set<string>} namedParamNames
 * @returns {string}
 */
function allocateParamN (counter, namedParamNames) {
  while (namedParamNames.has(`param${counter}`)) {
    counter++
  }
  return `param${counter}`
}

/**
 * URL-encode characters outside the RFC-1103 static-constant alphabet [A-Za-z0-9.-~_].
 * The 'u' flag ensures surrogate pairs are iterated as whole codepoints.
 * @param {string} str
 * @returns {string}
 */
function encodeStaticSegment (str) {
  return str.replaceAll(/[^A-Za-z0-9.\-~_]/gu, c => {
    const code = c.charCodeAt(0)
    if (code < 0x80) {
      return '%' + code.toString(16).toUpperCase().padStart(2, '0')
    }
    try {
      return encodeURIComponent(c)
    } catch {
      return '%EF%BF%BD'
    }
  })
}

/**
 * Build (and cache) a regex for a route segment, used by matchSegs for constraint-aware
 * optional resolution. Optional params use ([^/]*) / (constraint)? so 'v:major?' can match
 * just 'v' (empty capture → absent) or 'v2' (capture '2' → present).
 * @param {string} seg
 * @returns {RegExp}
 */
function getSegmentRegex (seg) {
  const cached = segmentRegexCache.get(seg)
  if (cached !== undefined) return cached

  let regexStr = ''
  let lastIdx = 0
  const matcher = /:([A-Za-z0-9_]+)(?:\(([^)]*)\))?([?*+])?/g
  let m
  while ((m = matcher.exec(seg)) !== null) {
    if (m.index > lastIdx) {
      regexStr += seg.slice(lastIdx, m.index).replaceAll(/[-[\]{}()*+?.,\\^$|#\s]/g, String.raw`\$&`)
    }
    const constraint = m[2]
    const modifier = m[3]
    if (constraint) {
      regexStr += modifier === '?' ? `(${constraint})?` : `(${constraint})`
    } else {
      regexStr += modifier === '?' ? '([^/]*)' : '([^/]+)'
    }
    lastIdx = m.index + m[0].length
  }
  if (lastIdx < seg.length) {
    regexStr += seg.slice(lastIdx).replaceAll(/[-[\]{}()*+?.,\\^$|#\s]/g, String.raw`\$&`)
  }

  let built
  try {
    built = new RegExp('^' + regexStr + '$')
  } catch {
    built = buildGenericSegmentRegex(seg)
  }
  segmentRegexCache.set(seg, built)
  return built
}

/**
 * Fallback segment regex without inline constraints.
 * @param {string} seg
 * @returns {RegExp}
 */
function buildGenericSegmentRegex (seg) {
  let regexStr = ''
  let lastIdx = 0
  const matcher = /:([A-Za-z0-9_]+)(?:\([^)]*\))?([?*+])?/g
  let m
  while ((m = matcher.exec(seg)) !== null) {
    if (m.index > lastIdx) {
      regexStr += seg.slice(lastIdx, m.index).replaceAll(/[-[\]{}()*+?.,\\^$|#\s]/g, String.raw`\$&`)
    }
    regexStr += m[2] === '?' ? '([^/]*)' : '([^/]+)'
    lastIdx = m.index + m[0].length
  }
  if (lastIdx < seg.length) {
    regexStr += seg.slice(lastIdx).replaceAll(/[-[\]{}()*+?.,\\^$|#\s]/g, String.raw`\$&`)
  }
  return new RegExp('^' + regexStr + '$')
}

// ---------------------------------------------------------------------------
// URL matching (used only for optional-param routes with the mergeParams fix)
// ---------------------------------------------------------------------------

/**
 * Backtracking route-vs-URL segment matcher.
 * Uses a single mutable params object to avoid per-branch allocation.
 * On success (returns true), params contains the captured values.
 * On failure (returns false), params may be partially populated (caller discards it).
 * On backtrack from a failed optional branch, deletes only the key added at this level.
 *
 * @param {string[]} routeSegs
 * @param {string[]} urlSegs
 * @param {number} ri
 * @param {number} ui
 * @param {object} params - mutable accumulator
 * @returns {boolean}
 */
function matchSegs (routeSegs, urlSegs, ri, ui, params) {
  if (ri === routeSegs.length) return ui === urlSegs.length

  const seg = routeSegs[ri]

  // Express 5 named wildcard: *name — catch-all, must be terminal
  const namedWildcard = NAMED_WILDCARD_RE.exec(seg)
  if (namedWildcard) {
    if (ri + 1 !== routeSegs.length) return false
    params[namedWildcard[1]] = urlSegs.slice(ui).join('/')
    return true
  }

  // Unnamed wildcard * — catch-all, terminal, no capture
  if (seg === '*') return ri + 1 === routeSegs.length

  const segParams = parseSegmentParams(seg)

  if (segParams.length === 0) {
    if (ui >= urlSegs.length || urlSegs[ui] !== seg) return false
    return matchSegs(routeSegs, urlSegs, ri + 1, ui + 1, params)
  }

  // Catch-all named param :name* or :name+ — terminal
  if (segParams.length === 1 && segParams[0].catchAll) {
    if (ri + 1 !== routeSegs.length) return false
    if (!segParams[0].zeroOrMore && ui >= urlSegs.length) return false
    params[segParams[0].name] = urlSegs.slice(ui).join('/')
    return true
  }

  // Single optional param — constraint-aware, with backtracking
  if (segParams.length === 1 && segParams[0].optional) {
    if (ui < urlSegs.length) {
      const m = getSegmentRegex(seg).exec(urlSegs[ui])
      if (m !== null) {
        const capturedValue = m[1]
        // Snapshot all keys before the greedy branch so we can restore them on failure.
        // Required params added by deeper recursive calls would otherwise remain as stale
        // keys when backtracking to the "optional absent" branch (e.g. /:a?/:b-:c?/:e/tail).
        const keysBefore = new Set(Object.keys(params))
        if (capturedValue) params[segParams[0].name] = capturedValue
        if (matchSegs(routeSegs, urlSegs, ri + 1, ui + 1, params)) return true
        // Backtrack: remove every key added during the failed greedy branch
        for (const key of Object.keys(params)) {
          if (!keysBefore.has(key)) delete params[key]
        }
      }
    }
    return matchSegs(routeSegs, urlSegs, ri + 1, ui, params)
  }

  // Required param(s) — must consume exactly one URL segment
  if (ui >= urlSegs.length) return false
  const urlSeg = urlSegs[ui]
  const segRegex = getSegmentRegex(seg)
  const segMatch = segRegex.exec(urlSeg)
  if (!segMatch) return false

  if (segParams.length === 1) {
    params[segParams[0].name] = segMatch[1]
    return matchSegs(routeSegs, urlSegs, ri + 1, ui + 1, params)
  }

  // Multi-param segment — extract each value from captures
  let captureIdx = 1
  for (const p of segParams) {
    const val = segMatch[captureIdx]
    if (val !== undefined && val !== '') params[p.name] = val
    captureIdx++
  }
  return matchSegs(routeSegs, urlSegs, ri + 1, ui + 1, params)
}

/**
 * Returns true if seg is a terminal catch-all that absorbs multiple URL segments.
 * Used to guard the URL-length early-exit in extractParamsFromUrl.
 * @param {string} seg
 * @returns {boolean}
 */
function segIsCatchAll (seg) {
  if (!seg) return false
  if (seg === '*' || NAMED_WILDCARD_RE.test(seg)) return true
  const sp = parseSegmentParams(seg)
  return sp.length === 1 && sp[0].catchAll
}

/**
 * Extract all path params by matching the route against the URL path.
 * Uses a null-prototype accumulator (avoids inherited property collisions).
 * @param {string[]} routeSegs - pre-split route segments (from OptionalRouteInfo)
 * @param {string} urlPath
 * @returns {object|null}
 */
function extractParamsFromUrl (routeSegs, urlPath) {
  const urlSegs = urlPath.split('/').filter(Boolean)
  // A terminal catch-all absorbs any number of URL segments — skip the length guard for those.
  if (urlSegs.length > routeSegs.length && !segIsCatchAll(routeSegs[routeSegs.length - 1])) return null
  const params = Object.create(null)
  return matchSegs(routeSegs, urlSegs, 0, 0, params) ? params : null
}

/**
 * Returns true if the segments array has any non-empty entry after index i.
 * @param {string[]} segments
 * @param {number} i
 * @returns {boolean}
 */
function hasMoreSegments (segments, i) {
  for (let j = i + 1; j < segments.length; j++) {
    if (segments[j] !== '') return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Route compilation (called once per unique route string)
// ---------------------------------------------------------------------------

/**
 * Build the normalised output for a pre-validated route.
 * Called once per route (non-optional) or once per presence-bitmask variant (optional).
 *
 * @param {string[]} segments - route.split('/')
 * @param {Set<string>} namedParamNames
 * @param {boolean} trailingSlash
 * @param {object|null|undefined} resolvedParams
 * @returns {string|null}
 */
function renderNormalized (segments, namedParamNames, trailingSlash, resolvedParams) {
  const result = []
  const paramCounter = 1

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    if (seg === '') continue

    const namedWildcard = NAMED_WILDCARD_RE.exec(seg)
    if (namedWildcard) {
      if (hasMoreSegments(segments, i)) return null
      result.push(`{${namedWildcard[1]}}`)
      break
    }

    if (seg === '*') {
      if (hasMoreSegments(segments, i)) return null
      result.push(`{${allocateParamN(paramCounter, namedParamNames)}}`)
      break
    }

    const segParams = parseSegmentParams(seg)

    if (segParams.length === 0) {
      result.push(encodeStaticSegment(seg))
      continue
    }

    if (segParams.length === 1 && segParams[0].catchAll) {
      if (hasMoreSegments(segments, i)) return null
      result.push(`{${segParams[0].name}}`)
      break
    }

    const presentNames = []
    for (const p of segParams) {
      if (p.optional) {
        if (resolvedParams != null && Object.hasOwn(resolvedParams, p.name) && resolvedParams[p.name]) {
          presentNames.push(p.name)
        }
      } else {
        presentNames.push(p.name)
      }
    }

    if (presentNames.length === 0) continue
    result.push(presentNames.length === 1 ? `{${presentNames[0]}}` : `{${presentNames.join('+')}}`)
  }

  const normalized = '/' + result.join('/')
  return trailingSlash && normalized !== '/' ? normalized + '/' : normalized
}

/**
 * Compile a route string into a cache entry.
 * Returns null for unsupported/always-null routes,
 * a string for non-optional routes (pre-computed result),
 * or an OptionalRouteInfo for routes with optional params.
 *
 * @param {string} route
 * @returns {null|string|OptionalRouteInfo}
 */
function buildRouteEntry (route) {
  if (hasUnsupportedSyntax(route)) return null
  if (route === '/') return '/'

  const trailingSlash = route.length > 1 && route.endsWith('/')
  const segments = route.split('/')
  const namedParamNames = collectNamedParamNames(route)

  // Check for optional params (only these routes need per-request resolution)
  let hasOptional = false
  const optionalNames = []
  for (const seg of segments) {
    if (seg === '') continue
    for (const p of parseSegmentParams(seg)) {
      if (p.optional) {
        hasOptional = true
        optionalNames.push(p.name)
      }
    }
  }

  if (!hasOptional) {
    // Pre-compute the result once — cached for all future requests
    return renderNormalized(segments, namedParamNames, trailingSlash, null)
  }

  // Optional route: return info object; variants cached on first request per bitmask
  return {
    optionalNames,
    variants: new Map(),
    segments,
    namedParamNames,
    trailingSlash,
    // Pre-split route segs for extractParamsFromUrl (avoids re-splitting per request)
    filteredSegments: segments.filter(Boolean),
  }
}

/**
 * Resolve an optional-param route per-request.
 * Uses a bitmask of which optional params are present to cache output variants.
 *
 * @param {OptionalRouteInfo} info
 * @param {object|null|undefined} params - req.params
 * @param {string|undefined} urlPath
 * @returns {string|null}
 */
function resolveOptional (info, params, urlPath) {
  const { optionalNames, variants, segments, namedParamNames, trailingSlash, filteredSegments } = info

  // Resolve params: use URL extraction only when req.params is missing optional params.
  // This skips the extraction cost for the common case (mergeParams is not the issue).
  let resolvedParams = params
  if (urlPath) {
    for (let i = 0; i < optionalNames.length; i++) {
      if (!params || !Object.hasOwn(params, optionalNames[i])) {
        resolvedParams = extractParamsFromUrl(filteredSegments, urlPath) ?? params
        break
      }
    }
  }

  // Compute a bitmask: bit i = 1 if optional param i is present in resolvedParams
  let bitmask = 0
  for (let i = 0; i < optionalNames.length; i++) {
    const name = optionalNames[i]
    if (resolvedParams != null && Object.hasOwn(resolvedParams, name) && resolvedParams[name]) {
      bitmask |= (1 << i)
    }
  }

  // Return cached variant if available
  const cached = variants.get(bitmask)
  if (cached !== undefined) return cached

  // First time seeing this combination — compute and cache
  const result = renderNormalized(segments, namedParamNames, trailingSlash, resolvedParams)
  variants.set(bitmask, result)
  return result
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Normalize an Express route string to the RFC-1103 _dd.appsec.normalized_route format.
 *
 * Hot-path: for routes without optional params, returns a cached string after the first
 * request. For optional-param routes, resolves which params are present and returns a
 * cached variant keyed by presence bitmask.
 *
 * @param {string} route - Express route string (e.g. value of http.route span tag)
 * @param {object|null|undefined} params - req.params from the matched request
 * @param {string|undefined} urlPath - URL path without query string; used to resolve
 *   optional params when req.params lacks parent-router params (mergeParams=false)
 * @returns {string|null} Normalized route, or null when normalization is not possible
 */
function normalizeRouteExpress (route, params, urlPath) {
  if (typeof route !== 'string' || !route) return null
  if (route.charAt(0) === '(') return null

  let entry = routeCache.get(route)
  if (entry === undefined) {
    entry = buildRouteEntry(route)
    routeCache.set(route, entry)
  }

  // null  → unsupported route or route that always returns null (e.g. non-terminal catch-all)
  if (entry === null) return null

  // string → pre-computed result for non-optional routes (~5 ns hot path)
  if (typeof entry === 'string') return entry

  // OptionalRouteInfo → resolve per-request with variant caching
  return resolveOptional(entry, params, urlPath)
}

module.exports = { normalizeRouteExpress }
