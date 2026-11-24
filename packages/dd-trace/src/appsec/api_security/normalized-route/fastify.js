'use strict'

const { LRUCache } = require('../../../../../../vendor/dist/lru-cache')

const web = require('../../../plugins/util/web')
const { renderRoute, isEmptyValue, segmentsFromTokens } = require('./renderer')

/** @type {WeakMap<string[], string | null>} */
const matchedRoutes = new WeakMap()

// Bound retention across router lifetimes. Keys are declared routes, never request URLs.
const routeCache = new LRUCache({ max: 4096 })
// Supported routes have one optional tail or catch-all; cache both rendered outputs.
const ABSENT = new Set()
const PRESENT = new Set([1])
const GROUP_PARENT = new Map([[1, 0]])

/**
 * Follow find-my-way's constraint delimiter rules, including escaped characters
 * and nested parentheses. The router has already validated and matched the regex.
 * @param {string} route
 * @param {number} index Opening parenthesis
 */
function skipConstraint (route, index) {
  let depth = 1
  while (++index < route.length) {
    const char = route[index]
    if (char === '\\') {
      index++
    } else if (char === '(') {
      depth++
    } else if (char === ')' && --depth === 0) {
      return index + 1
    }
  }
  return -1
}

/**
 * Parse a declared Fastify 4/5 route, never a request URL. Unlike Express,
 * punctuation such as +, { and } is allowed in names; only /, (, . and -
 * terminate the name. After a parameter, :: escapes a literal colon and an
 * unescaped colon introduces the next parameter in the same segment.
 * @param {string} route
 */
function compileRoute (route) {
  if (!route || (route[0] !== '/' && route !== '*')) return null
  // find-my-way makes the entire final /:... segment optional, including any
  // other params and static suffixes in it. A declared trailing slash stays outside.
  const question = route.endsWith('?') ? route.length - 1 : route.endsWith('?/') ? route.length - 2 : -1
  let optionalStart = -1
  if (question !== -1) {
    const start = route.lastIndexOf('/', question)
    const tail = route.slice(start, question)
    if (tail.startsWith('/:') && !tail.includes('(') && !tail.includes(')')) {
      optionalStart = start
      route = route.slice(0, question) + route.slice(question + 1)
    }
  }

  /** @type {(import('./renderer').RouteToken | { type: 'slash', group: number })[]} */
  const flat = []
  const requiredNames = new Set()
  let text = ''
  let index = 0
  let group = 0

  const flushText = () => {
    if (text) flat.push({ type: 'static', text, group })
    text = ''
  }

  while (index < route.length) {
    const char = route[index]
    if (char === '/') {
      flushText()
      if (index === optionalStart) group = 1
      if (index === route.length - 1) group = 0
      flat.push({ type: 'slash', group })
      index++
    } else if (char === ':' && route[index + 1] === ':') {
      text += ':'
      index += 2
    } else if (char === ':') {
      flushText()
      const start = ++index
      while (index < route.length && !'/.(-'.includes(route[index])) index++
      const name = route.slice(start, index)
      flat.push({ type: 'param', name, group })
      if (group === 0) requiredNames.add(name)

      if (route[index] === '(') {
        const end = skipConstraint(route, index)
        if (end === -1) return null
        index = end
      }

      // The suffix is static until the next parameter or URL segment. In
      // particular, a * here is a literal suffix, not a catch-all.
      while (index < route.length && route[index] !== '/') {
        if (route[index] === ':') {
          if (route[index + 1] !== ':') break
          index++
        }
        text += route[index++]
      }
    } else if (char === '*') {
      if (index !== route.length - 1 || group !== 0) return null
      flushText()
      flat.push({ type: 'wildcard', group: 1 })
      index++
    } else {
      text += char
      index++
    }
  }
  flushText()

  const optional = flat.filter(token => token.type === 'param' && token.group === 1 && !requiredNames.has(token.name))
  const wildcard = flat.at(-1)?.type === 'wildcard'
  const names = wildcard ? ['*'] : optional.map(token => token.name)
  // Static-only tails and names shared with required params cannot prove branch presence.
  if (optionalStart !== -1 && names.length === 0) return null

  const template = segmentsFromTokens(flat, GROUP_PARENT)
  const absent = renderRoute(template, ABSENT)
  return { names, wildcard, absent, present: names.length ? renderRoute(template, PRESENT) : absent }
}

/**
 * Normalize the declared route captured by Fastify.
 * @param {string | undefined} route
 * @param {Record<string, unknown>} [params]
 */
function normalizeRoute (route, params) {
  if (typeof route !== 'string') return null
  let compiled = routeCache.get(route)
  if (compiled === undefined) {
    compiled = compileRoute(route)
    routeCache.set(route, compiled)
  }
  if (compiled === null) return null

  if (params !== undefined) {
    for (const name of compiled.names) {
      // Optional branches expose their keys even for empty captures; only catch-alls omit empty values.
      if (Object.hasOwn(params, name) && (!compiled.wildcard || !isEmptyValue(params[name], true))) {
        return compiled.present
      }
    }
  }
  return compiled.absent
}

/**
 * @param {{ req: object, request?: { server?: { version?: string }, routerPath?: string,
 *   params?: Record<string, unknown> }, routeOptions?: { url?: string } }} event
 */
function onRequest ({ req, request, routeOptions }) {
  const version = request?.server?.version
  if (!version?.startsWith('4.') && !version?.startsWith('5.')) return

  // Before Fastify 4.10 the public declaration is exposed through routerPath.
  const route = routeOptions ? routeOptions.url : request.routerPath
  if (typeof route !== 'string') return
  const paths = web.getContext(req)?.paths
  if (paths?.length === 1 && paths[0] === route) {
    // Resolve before application hooks mutate params; retain only the normalized declaration.
    matchedRoutes.set(paths, normalizeRoute(route, request.params))
  }
}

/**
 * Read the capture for the final routing decision.
 * @param {object} req
 * @param {string | undefined} route
 */
function normalizeRequest (req, route) {
  const paths = web.getContext(req)?.paths
  // A manual http.route override must not reuse a different routing decision.
  if (paths?.length !== 1 || paths[0] !== route) return null
  // Another router's setRoute creates a new array, even for the same declaration.
  return matchedRoutes.get(paths) ?? null
}

module.exports = { normalizeRoute, normalizeRequest, onRequest }
