'use strict'

const path = require('path')
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

  const patched = new WeakSet()

  const safeHook = (moduleExports, moduleName, moduleBaseDir, moduleVersion, isIitm) => {
    if (patched.has(moduleExports)) return moduleExports

    const newExports = onrequire(moduleExports, moduleName, moduleBaseDir, moduleVersion, isIitm)

    if (isIitm && newExports.default && !patched.has(newExports.default) && (typeof newExports.default === 'object' || typeof newExports.default === 'function')) {
      onrequire(newExports.default, moduleName, moduleBaseDir, moduleVersion, isIitm)
      patched.add(newExports.default)
    }

    patched.add(newExports)
    patched.add(moduleExports)

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
