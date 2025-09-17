'use strict'

const iitm = require('../../../dd-trace/src/iitm')
const ritm = require('../../../dd-trace/src/ritm')

/**
 * This is called for every package/internal-module that dd-trace supports instrumentation for
 * In practice, `modules` is always an array with a single entry.
 *
 * @param {string[]} modules list of modules to hook into
 * @param {Function} onrequire callback to be executed upon encountering module
 */
function Hook (modules, hookOptions, onrequire) {
  if (!(this instanceof Hook)) return new Hook(modules, hookOptions, onrequire)

  if (typeof hookOptions === 'function') {
    onrequire = hookOptions
    hookOptions = {}
  }

  const patched = new WeakMap()

  const safeHook = (moduleExports, moduleName, moduleBaseDir, moduleVersion, isIitm) => {
    if (patched.has(moduleExports)) {
      return patched.get(moduleExports)
    }

    const newExports = onrequire(moduleExports, moduleName, moduleBaseDir, moduleVersion, isIitm)

    if (
      isIitm &&
      moduleExports.default &&
      (typeof moduleExports.default === 'object' ||
        typeof moduleExports.default === 'function')
    ) {
      newExports.default = onrequire(moduleExports.default, moduleName, moduleBaseDir, moduleVersion, isIitm)
    }

    if (newExports && (typeof newExports === 'object' || typeof newExports === 'function')) {
      patched.set(moduleExports, newExports)
    }

    return newExports
  }

  this._ritmHook = ritm(modules, {}, safeHook)
  this._iitmHook = iitm(modules, hookOptions, (moduleExports, moduleName, moduleBaseDir) => {
    return safeHook(moduleExports, moduleName, moduleBaseDir, null, true)
  })
}

Hook.prototype.unhook = function () {
  this._ritmHook.unhook()
  this._iitmHook.unhook()
}

module.exports = Hook
