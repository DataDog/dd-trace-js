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

    let defaultWrapResult
    if (
      isIitm &&
      moduleExports.default &&
      (typeof moduleExports.default === 'object' ||
        typeof moduleExports.default === 'function')
    ) {
      defaultWrapResult = onrequire(moduleExports.default, moduleName, moduleBaseDir, moduleVersion, isIitm)
      if (moduleName === 'express') {
        moduleExports.default = defaultWrapResult
        patched.set(moduleExports, moduleExports)
        return moduleExports
      }
    }

    const newExports = onrequire(moduleExports, moduleName, moduleBaseDir, moduleVersion, isIitm)
    if (defaultWrapResult) newExports.default = defaultWrapResult
    /**
     * TODO: Handle modules that use barrel files or exhibit unique patching edge cases.
     *
     * Known issues:
     * - protobufjs: This module performs barrel filing by adding exports dynamically.
     *   The first export lacks the properties we want to wrap, which causes it to be marked
     *   as patched even though it wasn’t correctly patched.
     *
     * - express: Fails when the outer moduleExports is wrapped, and then its `.default`
     *   export is wrapped again, leading to ESM tests failing.
     *
     * - aws-sdk: Patching `AWS.config` fails because the SDK reinstates its value even after
     *   being initially patched.
     *
     * NOTE: Many of these issues were previously hidden because our caching mechanism used
     * filename based keys, which ended up in modules rentering patching even though they should
     * have been cached.
     */
    if (newExports &&
      (typeof newExports === 'object' || typeof newExports === 'function') &&
      (moduleName === 'protobufjs' || !moduleName.includes('protobuf')) && !moduleName.includes('aws-sdk')) {
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
