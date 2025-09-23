'use strict'
const iitm = require('../../../dd-trace/src/iitm')
const ritm = require('../../../dd-trace/src/ritm')
// const path = require('path')

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
  this._patched = Object.create(null)
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
      if (moduleExports) patched.set(moduleExports, moduleExports)
      if (moduleName.includes('express')) {
        moduleExports.default = defaultWrapResult
        return moduleExports
      }
    }

    const newExports = onrequire(moduleExports, moduleName, moduleBaseDir, moduleVersion, isIitm)
    if (defaultWrapResult) newExports.default = defaultWrapResult
    /**
     * TODO: Find a way to deal with modules that have barrel files, and
     * add contents after each require, which break our moduleExport caching mechanism
     * (example: protobufjs)
     */
    if (newExports &&
      (typeof newExports === 'object' || typeof newExports === 'function') &&
      (moduleName === 'protobufjs' || !moduleName.includes('protobuf')) && !moduleName.includes('aws-sdk')) {
      patched.set(moduleExports, newExports)
    }

    return newExports
  }

  // const safeHook = (moduleExports, moduleName, moduleBaseDir, moduleVersion) => {
  //   const parts = [moduleBaseDir, moduleName].filter(Boolean)
  //   const filename = path.join(...parts)

  //   if (this._patched[filename]) return moduleExports

  //   this._patched[filename] = true

  //   return onrequire(moduleExports, moduleName, moduleBaseDir, moduleVersion)
  // }

  this._ritmHook = ritm(modules, {}, safeHook)
  this._iitmHook = iitm(modules, hookOptions, (moduleExports, moduleName, moduleBaseDir) => {
    // if (moduleExports && moduleExports.default) {
    //   moduleExports.default = safeHook(moduleExports.default, moduleName, moduleBaseDir)
    //   return moduleExports
    // }
    return safeHook(moduleExports, moduleName, moduleBaseDir, null, true)
  })
}

Hook.prototype.unhook = function () {
  this._ritmHook.unhook()
  this._iitmHook.unhook()
}

module.exports = Hook
