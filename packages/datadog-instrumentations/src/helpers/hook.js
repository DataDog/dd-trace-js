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

  this._patched = Object.create(null)

  const safeHook = (moduleExports, moduleName, moduleBaseDir, moduleVersion) => {
    const parts = [moduleBaseDir, moduleName].filter(Boolean)
    const filename = path.join(...parts)

    if (this._patched[filename]) return moduleExports

    this._patched[filename] = true

    // TODO: Move this logic to import-in-the-middle and only do it for CommonJS
    // modules and not ESM. In the meantime, all the modules we instrument are
    // CommonJS modules for which the default export is always moved to
    // `default` anyway.
    if (moduleExports && moduleExports.default) {
      const newDefault = onrequire(moduleExports.default, moduleName, moduleBaseDir, moduleVersion)
      if (newDefault !== moduleExports.default) {
        try {
          moduleExports.default = newDefault
        } catch {
          // default was a getter so the assignment failed. In those cases, we can't
          // replace the default, but that's fine since we only need to do that when
          // we're replacing the default itself, which is rare. Cases where we need
          // to replace the default _and_ it's not assignable should be so rare as
          // to not exist. I hope.
        }
      }
    }

    return onrequire(moduleExports, moduleName, moduleBaseDir, moduleVersion)
  }

  this._ritmHook = ritm(modules, {}, safeHook)
  this._iitmHook = iitm(modules, hookOptions, (moduleExports, moduleName, moduleBaseDir) => {
    return safeHook(moduleExports, moduleName, moduleBaseDir)
  })
}

Hook.prototype.unhook = function () {
  this._ritmHook.unhook()
  this._iitmHook.unhook()
  this._patched = Object.create(null)
}

module.exports = Hook
