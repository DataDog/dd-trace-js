'use strict'

const { addHook } = require('./helpers/instrument')

/** @type {((pattern: string | RegExp) => RegExp | undefined) | undefined} */
let compileToRegexp

/** @type {((pattern: string) => { tokens: object[] } | undefined) | undefined} */
let parseTokens

/** @type {((route: string) => ((url: string) => object | undefined) | undefined) | undefined} */
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

  // Capture path-to-regexp 8.x's `parse()` and `match()` together (Express 5). Probe `parse` for the
  // v8 TokenData shape ({ tokens: [...] }) and adopt this module's `match()` only when it holds. Tying
  // both to the same confirmed-v8 module stops a later-loaded older major — whose `parse` returns a
  // bare array, or whose `match` shares the { params } shape — from clobbering a working v8 adapter.
  if (typeof moduleExports?.parse === 'function' && typeof moduleExports?.match === 'function') {
    const parse = moduleExports.parse
    const match = moduleExports.match
    let probe
    try {
      probe = parse('/')
    } catch {
      // not a usable v8 module
    }
    if (Array.isArray(probe?.tokens)) {
      parseTokens = pattern => {
        let result
        try {
          result = parse(pattern)
        } catch {
          return
        }
        if (Array.isArray(result?.tokens)) return result
      }
      makeMatcher = route => {
        let matcher
        try {
          matcher = match(route)
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
 * Returns the host's path-to-regexp 8.x `match` adapter: a factory `route => (url => params)` that
 * compiles a route once and returns a matcher yielding the captured params (or undefined on no
 * match / unusable route). `undefined` when the host has not loaded an 8.x path-to-regexp.
 * @returns {((route: string) => ((url: string) => object | undefined) | undefined) | undefined}
 */
function getMatch () {
  return makeMatcher
}

module.exports = { getCompileToRegexp, getParse, getMatch }
