'use strict'

const path = require('path')
const iitm = require('../../../dd-trace/src/iitm')
const ritm = require('../../../dd-trace/src/ritm')
const dcitm = require('../../../dd-trace/src/dcitm')

/**
 * This is called for every module that dd-trace supports instrumentation for.
 * In practice, `modules` is always an array with a single entry.
 *
 * @param {string[]} modules list of modules to hook into
 * @param {Function} onrequire callback to be executed upon encountering module
 */
function Hook (modules, onrequire) {
  if (!(this instanceof Hook)) return new Hook(modules, onrequire)

  this._patched = Object.create(null)

  const safeHook = (moduleExports, moduleName, moduleBaseDir, moduleVersion) => {
    const parts = [moduleBaseDir, moduleName].filter(v => v)
    const filename = path.join(...parts)

    if (this._patched[filename]) return moduleExports

    this._patched[filename] = true

    return onrequire(moduleExports, moduleName, moduleBaseDir, moduleVersion)
  }

  this._ritmHook = ritm(modules, {}, safeHook)
  this._iitmHook = iitm(modules, {}, (moduleExports, moduleName, moduleBaseDir) => {
    // TODO: Move this logic to import-in-the-middle and only do it for CommonJS
    // modules and not ESM. In the meantime, all the modules we instrument are
    // CommonJS modules for which the default export is always moved to
    // `default` anyway.
    if (moduleExports && moduleExports.default) {
      moduleExports.default = safeHook(moduleExports.default, moduleName, moduleBaseDir)
      return moduleExports
    } else {
      return safeHook(moduleExports, moduleName, moduleBaseDir)
    }
  })
  this._dcitmHook = dcitm(modules, {}, safeHook)
}

Hook.prototype.unhook = function () {
  this._ritmHook.unhook()
  this._iitmHook.unhook()
  this._dcitmHook.unhook()
  this._patched = Object.create(null)
}

module.exports = Hook
