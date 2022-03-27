'use strict'

const path = require('path')
const iitm = require('../../../dd-trace/src/iitm')
const ritm = require('../../../dd-trace/src/ritm')

function Hook (modules, onrequire) {
  if (!(this instanceof Hook)) return new Hook(modules, onrequire)

  this._patched = {}

  const safeHook = (moduleExports, moduleName, moduleBaseDir) => {
    const parts = [moduleBaseDir, moduleName].filter(v => v)
    const filename = path.join(...parts)

    if (this._patched[filename]) return moduleExports

    this._patched[filename] = true

    return onrequire(moduleExports, moduleName, moduleBaseDir)
  }

  this._ritmHook = ritm(modules, {}, safeHook)
  this._iitmHook = iitm(modules, {}, (moduleExports, moduleName, moduleBaseDir) => {
    // Default export is always moved to `default` for CommonJS modules.
    if (moduleExports && moduleExports.default) {
      moduleExports.default = safeHook(moduleExports.default, moduleName, moduleBaseDir)
      return moduleExports
    } else {
      return safeHook(moduleExports, moduleName, moduleBaseDir)
    }
  })
}

Hook.prototype.unhook = function () {
  this._ritmHook.unhook()
  this._iitmHook.unhook()
  this._patched = {}
}

module.exports = Hook
