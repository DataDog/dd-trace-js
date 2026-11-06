'use strict'

const { LRUCache } = require('../../../../../../vendor/dist/lru-cache')

const { renderRoute } = require('./renderer')
const { segmentsFromTokens } = require('./segments')

// Bound retention across router lifetimes. Keys are declared routes, never request URLs.
const routeCache = new LRUCache({ max: 4096 })
const EMPTY_SET = new Set()
const EMPTY_MAP = new Map()

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
  // Optional branches require match information that the declaration alone cannot provide.
  if (route.endsWith('?') || route.endsWith('?/')) return null

  /** @type {(import('./renderer').RouteToken | { type: 'slash', group: number })[]} */
  const flat = []
  let text = ''
  let index = 0

  const flushText = () => {
    if (text) flat.push({ type: 'static', text, group: 0 })
    text = ''
  }

  while (index < route.length) {
    const char = route[index]
    if (char === '/') {
      flushText()
      flat.push({ type: 'slash', group: 0 })
      index++
    } else if (char === ':' && route[index + 1] === ':') {
      text += ':'
      index += 2
    } else if (char === ':') {
      flushText()
      const start = ++index
      while (index < route.length && !'/.(-'.includes(route[index])) index++
      const name = route.slice(start, index)
      flat.push({ type: 'param', name: name || undefined, group: 0 })

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
      if (index !== route.length - 1) return null
      flushText()
      flat.push({ type: 'wildcard', group: 0 })
      index++
    } else {
      text += char
      index++
    }
  }
  flushText()

  return renderRoute(segmentsFromTokens(flat, EMPTY_MAP), EMPTY_SET)
}

/**
 * Normalize the declared route captured by Fastify.
 * @param {string | undefined} route
 */
function normalizeRoute (route) {
  if (typeof route !== 'string') return null
  let normalized = routeCache.get(route)
  if (normalized === undefined) {
    normalized = compileRoute(route)
    routeCache.set(route, normalized)
  }
  return normalized
}

module.exports = { normalizeRoute }
