'use strict'

const { channel } = require('dc-polyfill')
const web = require('../../plugins/util/web')

// Per-request stack of layer route fragments.
const stacks = new WeakMap()

for (const base of ['express', 'router']) {
  channel(`apm:${base}:middleware:enter`).subscribe(({ req, route }) => {
    if (!route) return
    let s = stacks.get(req)
    if (!s) {
      s = []
      stacks.set(req, s)
    }
    s.push(route)
  })
  channel(`apm:${base}:middleware:next`).subscribe(({ req }) => {
    stacks.get(req)?.pop()
  })
}

// parameter names exclude `/?#+{}` (those 6 must be percent-encoded).
const PARAM_NAME_DISALLOWED = /[/?#+{}]/g

// One route-dynamic marker: `:name[*+]` (param, with optional v4 wildcard modifier) or `*name`
// (v8 named wildcard) or `*` (v4 unnamed wildcard).
const MARKER_RE = /:(\w+)([*+])?|\*(\w*)/g

/**
 * Compute `_dd.appsec.normalized_route` for an Express request.
 *
 * @param {object} req
 * @returns {string | null}
 */
function normalizeRoute (req) {
  if (web.root(req)?.context()?.getTag?.('component') !== 'express') return null
  const stack = stacks.get(req)
  let route = stack?.length ? stack.join('') : null
  if (!route) {
    const paths = web.getContext(req)?.paths
    route = paths?.length > 1 ? paths.join('') : paths?.[0]
  }
  if (!route) return null
  return normalizeRouteExpress(route, req.params, urlPathOf(req))
}

/**
 * Normalize an Express route string per RFC-1103. Returns `null` on unrepresentable input
 * (regex routes, quoted v8 names, unbalanced braces).
 *
 * @param {string} route
 * @param {object | null | undefined} params
 * @param {string} [urlPath] - used only to disambiguate static-only optional groups
 * @returns {string | null}
 */
function normalizeRouteExpress (route, params, urlPath) {
  if (typeof route !== 'string' || !route || route.charAt(0) === '(') return null
  // RFC: "omit rather than emit an inaccurate value". v8 quoted names (`:"name"`) carry chars
  // our marker regex can't capture; rather than fall through to encodeStatic and produce a
  // garbled element, drop the tag.
  if (route.includes(':"')) return null
  const staticOnly = countStaticOnlyGroups(route)
  if (staticOnly === 0 || !urlPath || staticOnly > 6) {
    return tryRender(route, params, new Array(staticOnly).fill(false))
  }
  // Static-only groups can't be decided from req.params alone; enumerate the 2^N variants
  // (capped at N=6 → 64 iterations) and pick the one whose segment count matches the URL.
  const expectedSegs = countUrlSegments(urlPath)
  let fallback = null
  for (let mask = 0; mask < (1 << staticOnly); mask++) {
    const decisions = []
    for (let i = 0; i < staticOnly; i++) decisions.push((mask & (1 << i)) !== 0)
    const out = tryRender(route, params, decisions)
    if (out === null) continue
    fallback ??= out
    if (countRenderedSegments(out) === expectedSegs) return out
  }
  return fallback
}

/**
 * One pass of the pipeline: expand `{…}` → strip `:name(c)` → resolve `:name?` → renderRoute.
 *
 * @param {string} route
 * @param {object | null | undefined} params
 * @param {boolean[]} decisions - presence per static-only group, consumed in order
 * @returns {string | null}
 */
function tryRender (route, params, decisions) {
  let slot = 0
  const expanded = expandBraces(route, params, () => decisions[slot++])
  if (expanded === null) return null
  // Strip `:name(constraint)` first so that `:name(c)?` becomes `:name?` and the next pass can
  // resolve the modifier; otherwise the `?` outlives both passes and ends up in static text.
  const noConstraint = expanded.replaceAll(/:(\w+)\([^)]*\)/g, ':$1')
  const noOptional = noConstraint.replaceAll(/([./])?:(\w+)\?/g, (_, delim, name) =>
    isPresent(params, name) ? `${delim ?? ''}:${name}` : ''
  )
  return renderRoute(noOptional)
}

/**
 * Resolve `{…}` optional groups against `params` (and `decideStaticOnly()` for static-only
 * groups). Returns `null` on unbalanced braces.
 *
 * @param {string} route
 * @param {object | null | undefined} params
 * @param {() => boolean} decideStaticOnly
 * @returns {string | null}
 */
function expandBraces (route, params, decideStaticOnly) {
  let out = ''
  let i = 0
  while (i < route.length) {
    const c = route[i]
    if (c === '\\' && i + 1 < route.length) { out += route[i + 1]; i += 2; continue }
    if (c === '{') {
      const end = matchBrace(route, i)
      if (end < 0) return null
      const inner = expandBraces(route.slice(i + 1, end), params, decideStaticOnly)
      if (inner === null) return null
      // A group renders iff one of its `:name` is present in req.params; static-only groups
      // (no markers) defer to a URL-segment-count decision injected by the caller.
      const fires = anyParamPresent(inner, params) || (!hasMarker(inner) && decideStaticOnly())
      if (fires) out += inner
      i = end + 1
      continue
    }
    out += c
    i++
  }
  return out
}

/**
 * Render a plain route (only `:name` / `*name` markers) to the RFC normalized form.
 *
 * @param {string} plain
 * @returns {string}
 */
function renderRoute (plain) {
  const trailing = plain.length > 1 && plain.endsWith('/')
  const body = plain.replace(/^\/+/, '').replace(/\/+$/, '').replaceAll(/\/+/g, '/')
  if (!body) return '/'

  const segParsed = body.split('/').map(parseSegment)
  const dyn = segParsed.flatMap(s => s.dynamics)
  const names = resolveNames(dyn)

  const out = []
  let ptr = 0
  for (const seg of segParsed) {
    if (seg.dynamics.length === 0) { out.push(encodeStatic(seg.staticText)); continue }
    const segNames = seg.dynamics.map(() => names[ptr++])
    if (seg.catchAll) {
      // Rule 5 catch-all exception: terminal single atomic element subsuming the rest.
      out.push(`{${segNames.join('+')}}`)
      break
    }
    if (segNames.length === 1 && seg.staticText === '') out.push(`{${segNames[0]}}`)
    else out.push(`{${segNames.join('+')}}`) // Rule 5: combined element
  }

  const result = '/' + out.join('/')
  return trailing && result !== '/' ? result + '/' : result
}

/**
 * Split one URL segment into its static text and dynamic markers in declaration order.
 *
 * @param {string} seg
 * @returns {{ staticText: string, dynamics: { name: string | null }[], catchAll: boolean }}
 */
function parseSegment (seg) {
  const dynamics = []
  let staticText = ''
  let last = 0
  let catchAll = false
  for (const m of seg.matchAll(MARKER_RE)) {
    staticText += seg.slice(last, m.index)
    last = m.index + m[0].length
    const isCatchAll = m[3] !== undefined || m[2] === '*' || m[2] === '+'
    dynamics.push({ name: (m[1] ?? m[3]) || null })
    if (isCatchAll) catchAll = true
  }
  staticText += seg.slice(last)
  return { staticText, dynamics, catchAll }
}

/**
 * Assign unique names per RFC rule 4: keep the LAST occurrence of each framework name; earlier
 * duplicates and unnamed wildcards become `param<N>` (skipping N values already taken).
 *
 * @param {{ name: string | null }[]} dyn
 * @returns {string[]}
 */
function resolveNames (dyn) {
  const encoded = dyn.map(d => d.name == null ? null : encodeParamName(d.name))
  const lastIdx = new Map()
  for (let i = 0; i < encoded.length; i++) if (encoded[i] != null) lastIdx.set(encoded[i], i)
  const used = new Set()
  for (let i = 0; i < dyn.length; i++) {
    if (encoded[i] != null && lastIdx.get(encoded[i]) === i) used.add(encoded[i])
  }
  const out = new Array(dyn.length)
  let n = 1
  for (let i = 0; i < dyn.length; i++) {
    if (encoded[i] != null && lastIdx.get(encoded[i]) === i) {
      out[i] = encoded[i]
    } else {
      while (used.has(`param${n}`)) n++
      out[i] = `param${n}`
      used.add(`param${n}`)
      n++
    }
  }
  return out
}

/**
 * Index of the `}` matching the `{` at `start`, or `-1` if unbalanced. Handles nesting and `\X`.
 *
 * @param {string} s
 * @param {number} start
 * @returns {number}
 */
function matchBrace (s, start) {
  let depth = 0
  for (let i = start; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue }
    if (s[i] === '{') depth++
    else if (s[i] === '}' && --depth === 0) return i
  }
  return -1
}

/**
 * Count `{…}` groups (incl. nested) that contain no dynamic markers — those `params` can't
 * disambiguate.
 *
 * @param {string} route
 * @returns {number}
 */
function countStaticOnlyGroups (route) {
  let count = 0
  let i = 0
  while (i < route.length) {
    if (route[i] === '\\') { i += 2; continue }
    if (route[i] === '{') {
      const end = matchBrace(route, i)
      if (end < 0) return count
      const inner = route.slice(i + 1, end)
      if (!hasMarker(inner)) count++
      count += countStaticOnlyGroups(inner)
      i = end + 1
      continue
    }
    i++
  }
  return count
}

/**
 * True iff `s` contains at least one `:name` or `*name` marker.
 *
 * @param {string} s
 * @returns {boolean}
 */
function hasMarker (s) {
  return /:\w+|\*\w*/.test(s)
}

/**
 * True iff any marker name in `s` is bound in `params`.
 *
 * @param {string} s
 * @param {object | null | undefined} params
 * @returns {boolean}
 */
function anyParamPresent (s, params) {
  if (!params) return false
  for (const m of s.matchAll(MARKER_RE)) {
    const name = m[1] ?? m[3]
    if (name && isPresent(params, name)) return true
  }
  return false
}

/**
 * True iff `params` has an own truthy non-empty value for `name`.
 *
 * @param {object | null | undefined} params
 * @param {string} name
 * @returns {boolean}
 */
function isPresent (params, name) {
  return params != null && Object.hasOwn(params, name) && params[name] != null && params[name] !== ''
}

/**
 * Percent-encode chars outside `[A-Za-z0-9.-~_]`; pass valid `%XX` through (uppercased).
 *
 * @param {string} str
 * @returns {string}
 */
function encodeStatic (str) {
  return str.replaceAll(/%[\dA-Fa-f]{2}|[^A-Za-z0-9.\-~_]/gu, m => {
    if (m.charCodeAt(0) === 0x25) return m.toUpperCase()
    const code = m.charCodeAt(0)
    if (code < 0x80) return '%' + code.toString(16).toUpperCase().padStart(2, '0')
    try { return encodeURIComponent(m) } catch { return '%EF%BF%BD' }
  })
}

/**
 * Percent-encode the 6 chars disallowed in a parameter name (`/?#+{}`).
 *
 * @param {string} name
 * @returns {string}
 */
function encodeParamName (name) {
  return name.replaceAll(PARAM_NAME_DISALLOWED, c =>
    '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')
  )
}

/**
 * URL path (no query string) from a request; prefers `originalUrl`.
 *
 * @param {{ originalUrl?: string, url?: string }} req
 * @returns {string | undefined}
 */
function urlPathOf (req) {
  const raw = req.originalUrl || req.url
  const q = raw ? raw.indexOf('?') : -1
  return q === -1 ? raw : raw.slice(0, q)
}

/**
 * Count non-empty `/`-delimited segments in a URL path.
 *
 * @param {string} urlPath
 * @returns {number}
 */
function countUrlSegments (urlPath) {
  return urlPath.split('/').filter(Boolean).length
}

/**
 * Count atomic elements in a rendered normalized route.
 *
 * @param {string} rendered
 * @returns {number}
 */
function countRenderedSegments (rendered) {
  if (rendered === '/' || !rendered) return 0
  return rendered.replaceAll(/^\/+|\/+$/g, '').split('/').length
}

module.exports = {
  normalizeRoute,
  normalizeRouteExpress,
  // Test only
  tryRender,
  expandBraces,
  renderRoute,
  parseSegment,
  resolveNames,
  matchBrace,
  countStaticOnlyGroups,
  hasMarker,
  anyParamPresent,
  isPresent,
  encodeStatic,
  encodeParamName,
  urlPathOf,
  countUrlSegments,
  countRenderedSegments,
}
