'use strict'

const path = require('path')

const iitm = require('../../../dd-trace/src/iitm')
const ritm = require('../../../dd-trace/src/ritm')
const log = require('../../../dd-trace/src/log')
const requirePackageJson = require('../../../dd-trace/src/require-package-json')

// process.getBuiltinModule lands in Node 22.3 / backported to 20.16. The built-in
// double-wrap it guards against only happens where the synchronous loader owns
// CommonJS (Node >=22.22.3), so it is always present when the sync path runs.
const getBuiltinModule =
  // eslint-disable-next-line n/no-unsupported-features/node-builtins -- guarded; only reached on Node >=22.22.3
  typeof process.getBuiltinModule === 'function' ? process.getBuiltinModule : undefined

/**
 * @param {string} moduleBaseDir
 * @returns {string|undefined}
 */
function getVersion (moduleBaseDir) {
  if (moduleBaseDir) {
    return requirePackageJson(moduleBaseDir, /** @type {import('module').Module} */ (module)).version
  }

  // In a packaged Electron binary, built-in modules (like 'electron', 'electron/main') have no
  // moduleBaseDir. Use the Electron version for version checks when available, otherwise fall back
  // to the Node.js version.
  return process.versions?.electron ?? process.version
}

/**
 * This is called for every package/internal-module that dd-trace supports instrumentation for
 * In practice, `modules` is always an array with a single entry.
 *
 * @overload
 * @param {string[]} modules list of modules to hook into
 * @param {object} hookOptions hook options
 * @param {Function} onrequire callback to be executed upon encountering module
 */
/**
 * @overload
 * @param {string[]} modules list of modules to hook into
 * @param {object} hookOptions hook options
 * @param {Function} onrequire callback to be executed upon encountering module
 */
function Hook (modules, hookOptions, onrequire) {
  // TODO: Rewrite this to use class syntax. The same should be done for ritm.
  if (!(this instanceof Hook)) return new Hook(modules, hookOptions, onrequire)

  if (typeof hookOptions === 'function') {
    onrequire = hookOptions
    hookOptions = {}
  }

  this._patched = Object.create(null)
  const patched = new WeakMap()

  const safeHook = (moduleExports, moduleName, moduleBaseDir, moduleVersion, isIitm) => {
    const parts = [moduleBaseDir, moduleName].filter(Boolean)
    const filename = path.join(...parts)

    let defaultWrapResult

    const wrappedOnrequire = (moduleExports, ...args) => {
      if (this._patched[filename] && patched.has(moduleExports)) {
        return patched.get(moduleExports)
      }

      const result = onrequire(moduleExports, ...args)
      if (result && (typeof result === 'object' || typeof result === 'function')) {
        patched.set(moduleExports, result)
        patched.set(result, result)
      }

      return result
    }

    try {
      moduleVersion ||= getVersion(moduleBaseDir)
    } catch (error) {
      log.error('Error getting version for "%s": %s', moduleName, error.message, error)
      return
    }

    // A built-in (no base directory) is wrapped once on its shared singleton via
    // process.getBuiltinModule() when the synchronous loader owns CommonJS. An ESM
    // `import` of it then arrives here a second time with the namespace iitm built;
    // re-running the hook would wrap the singleton's methods twice (firing the
    // instrumentation twice per call and corrupting shims like http2's). Instead,
    // copy the already-wrapped members from the singleton onto the namespace so
    // named imports (`import { createHash }`) resolve to the wrapped function
    // without a second wrap. Only reachable on Node that ships getBuiltinModule,
    // which is exactly where the singleton wrap and this collision occur.
    if (isIitm && !moduleBaseDir && this._patched[filename] && getBuiltinModule !== undefined) {
      const singleton = getBuiltinModule(moduleName)
      if (singleton !== undefined && singleton !== moduleExports) {
        for (const key of Reflect.ownKeys(singleton)) {
          if (key === 'default') continue
          try {
            if (moduleExports[key] !== singleton[key]) moduleExports[key] = singleton[key]
          } catch {
            // Read-only namespace binding; nothing to sync for this member.
          }
        }
        return moduleExports
      }
    }

    if (
      isIitm &&
      moduleExports.default &&
      (typeof moduleExports.default === 'object' ||
      typeof moduleExports.default === 'function')
    ) {
      defaultWrapResult = wrappedOnrequire(moduleExports.default, moduleName, moduleBaseDir, moduleVersion, isIitm)
    }

    const newExports = wrappedOnrequire(moduleExports, moduleName, moduleBaseDir, moduleVersion, isIitm)

    if (defaultWrapResult) newExports.default = defaultWrapResult

    this._patched[filename] = true

    return newExports
  }

  this._ritmHook = ritm(modules, {}, safeHook)
  this._iitmHook = iitm(modules, hookOptions, (moduleExports, moduleName, moduleBaseDir) => {
    return safeHook(moduleExports, moduleName, moduleBaseDir, null, true)
  })
}

module.exports = Hook
