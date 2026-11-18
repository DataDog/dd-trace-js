'use strict'

const { addHook } = require('./helpers/instrument')

/** @type {((pattern: string | RegExp) => RegExp | undefined) | undefined} */
let compileToRegexp

/** @type {((pattern: string) => { tokens: object[] } | undefined) | undefined} */
let parseTokens

/**
 * @typedef {(tokens: object[], options?: { sensitive?: boolean, trailing?: boolean })
 *   => ((url: string) => object | undefined) | undefined} MatcherFactory
 */

/** @type {MatcherFactory | undefined} */
let makeMatcher

addHook({ name: 'path-to-regexp', versions: ['*'] }, moduleExports => {
  // 0.1.x and 6.x: `module.exports = (path, ...) => RegExp`.
  // 7.x: `module.exports = { pathToRegexp(path, ...) => RegExp }`.
  // 8.x: `module.exports = { pathToRegexp(path, ...) => { regexp, keys } }`.
  const compile = typeof moduleExports === 'function'
    ? moduleExports
    : (typeof moduleExports?.pathToRegexp === 'function' ? moduleExports.pathToRegexp : undefined)

  if (compile !== undefined) {
    compileToRegexp = pattern => {
      let result
      try {
        result = compile(pattern)
      } catch {
        return
      }
      const regex = result?.regexp ?? result
      if (regex instanceof RegExp) return regex
    }
  }

  return moduleExports
})

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
        // Callers read raw param values only: skipping decode is faster and stops a malformed
        // escape ('%ZZ') from throwing URIError, which would read as "no match". 8.0.0's match()
        // requires a real TokenData instance for pre-parsed tokens.
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
        return result ? result.params : undefined
      }
    }
  }

  return moduleExports
})

/**
 * Returns whatever path-to-regexp compile adapter the host most recently
 * loaded. Capture this once at addHook fire time so each express/router
 * instance keeps the dialect that was current when its routes were wrapped;
 * a later host load that swaps the global compile won't retroactively change
 * already-wrapped routers. `undefined` when the host has not loaded
 * path-to-regexp yet, or never if it does not depend on it.
 */
function getCompileToRegexp () {
  return compileToRegexp
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
 * Returns the host's path-to-regexp 8.x `match` adapter: a factory `(tokens, options) =>
 * (url => params)` that compiles a token sequence once (as `match(new TokenData(...))`, with the
 * caller's `sensitive`/`trailing` options) and returns a matcher yielding the raw captured
 * params (or undefined on no match / unusable tokens).
 * `undefined` when the host has not loaded an 8.x path-to-regexp.
 * @returns {MatcherFactory | undefined}
 */
function getMatch () {
  return makeMatcher
}

module.exports = { getCompileToRegexp, getParse, getMatch }
