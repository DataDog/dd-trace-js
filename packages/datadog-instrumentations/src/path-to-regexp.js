'use strict'

const { addHook } = require('./helpers/instrument')

/** @type {((pattern: string | RegExp) => RegExp | undefined) | undefined} */
let compileToRegexp

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

module.exports = { getCompileToRegexp }
