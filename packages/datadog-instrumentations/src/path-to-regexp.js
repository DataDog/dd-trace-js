'use strict'

const { createRequire } = require('node:module')

const log = require('../../dd-trace/src/log')
const { addHook } = require('./helpers/instrument')

/** @typedef {{ sensitive?: boolean, end: boolean, trailing: boolean }} RouteOptions */
/** @typedef {RegExp | { test: (path: string) => object | false }} CompiledRoute */
/** @typedef {(pattern: string | RegExp, options?: RouteOptions) => CompiledRoute | undefined} RouteCompiler */
/** @type {RouteCompiler | undefined} */
let compileRoute

/** @type {((pattern: string) => { tokens: object[] } | undefined) | undefined} */
let parseTokens

/** @type {((tokens: object[], options?: object) => ((url: string) => object | undefined) | undefined) | undefined} */
let makeMatcher

addHook({ name: 'path-to-regexp', versions: ['*'] }, moduleExports => {
  // 0.1.x and 6.x: `module.exports = (path, ...) => RegExp`.
  // 7.x: `module.exports = { pathToRegexp(path, ...) => RegExp }`.
  // 8.1+: `module.exports = { pathToRegexp(path, ...) => { regexp, keys } }`.
  const compile = typeof moduleExports === 'function'
    ? moduleExports
    : (typeof moduleExports?.pathToRegexp === 'function' ? moduleExports.pathToRegexp : undefined)

  if (compile !== undefined) {
    compileRoute = createCompiler(compile, typeof moduleExports !== 'function')
  }

  return moduleExports
})

/**
 * @param {Function} compile
 * @param {boolean} acceptsOptions
 */
function createCompiler (compile, acceptsOptions) {
  return (pattern, options) => {
    let result
    try {
      result = acceptsOptions && options !== undefined ? compile(pattern, options) : compile(pattern)
    } catch {
      return
    }
    if (typeof result === 'function') return { test: result }
    const regex = result?.regexp ?? result
    if (regex instanceof RegExp) return regex
  }
}

// 8.x only: earlier majors also expose `parse`/`match`, but with incompatible shapes — 7.x returns
// `{ tokens }` too, yet its tokens are bare strings rather than typed nodes. Gating on the version
// keeps those from installing adapters the consumers would misread.
addHook({ name: 'path-to-regexp', versions: ['>=8'] }, moduleExports => {
  const { parse, match, TokenData } = moduleExports

  if (typeof parse === 'function' && typeof match === 'function' && typeof TokenData === 'function') {
    parseTokens = pattern => {
      let result
      try {
        result = parse(pattern)
      } catch {
        return
      }
      if (Array.isArray(result?.tokens)) return result
    }

    makeMatcher = (tokens, options) => {
      let matcher
      try {
        // Callers read raw param values only: skipping decode is faster and
        // stops a malformed escape ('%ZZ') from throwing URIError, which would read as "no match".
        matcher = match(new TokenData(tokens), { ...options, decode: false })
      } catch {
        return
      }
      return url => {
        let result
        try {
          result = matcher(url)
        } catch {
          return
        }
        return result || undefined
      }
    }
  }

  return moduleExports
})

/**
 * Prefer the router's own path-to-regexp. Hosts without a module filename
 * capture the adapter that was current when their hook ran.
 * @param {string} [hostFile] The host source file that imports path-to-regexp.
 */
function getRouteCompiler (hostFile) {
  if (hostFile !== undefined) {
    try {
      const requireFromHost = createRequire(hostFile)
      const { pathToRegexp, match } = requireFromHost('path-to-regexp')
      if (typeof pathToRegexp === 'function') return createCompiler(pathToRegexp, true)
      // 8.0.0 exposes match() and keeps its compiled RegExp private.
      return createCompiler((pattern, options) => match(pattern, { ...options, decode: false }), true)
    } catch (error) {
      log.debug('Could not load path-to-regexp for %s: %s', hostFile, error)
    }
  }
  return compileRoute
}

/**
 * Returns the host's path-to-regexp `parse` adapter (8.x token tree), or `undefined` when the
 * host has not loaded an 8.x path-to-regexp (e.g. Express 4 ships 0.1.x, which has no `parse`).
 * @returns {((pattern: string) => { tokens: object[] } | undefined) | undefined}
 */
function getParse () {
  return parseTokens
}

/**
 * Returns the host's path-to-regexp 8.x `match` adapter: a factory `(tokens, options) => (url => match)`
 * that compiles a token sequence once and returns a matcher yielding the matched `{ path, params }` (or
 * undefined on no match / unusable route). `undefined` when the host has not loaded an 8.x path-to-regexp.
 * @returns {((tokens: object[], options?: object) => ((url: string) => object | undefined) | undefined) | undefined}
 */
function getMatch () {
  return makeMatcher
}

module.exports = { getRouteCompiler, getParse, getMatch }
