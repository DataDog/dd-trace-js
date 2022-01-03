'use strict'

const path = require('path')
const Module = require('module')
const parse = require('module-details-from-path')

const origRequire = Module.prototype.require

// derived from require-in-the-middle@3 with tweaks

module.exports = Hook

Hook.reset = function () {
  Module.prototype.require = origRequire
}

function Hook (modules, options, onrequire) {
  if (!(this instanceof Hook)) return new Hook(modules, options, onrequire)
  if (typeof modules === 'function') {
    onrequire = modules
    modules = null
    options = {}
  } else if (typeof options === 'function') {
    onrequire = options
    options = {}
  }

  options = options || {}

  this.cache = {}
  this._unhooked = false
  this._origRequire = Module.prototype.require

  const self = this
  const patching = {}

  this._require = Module.prototype.require = function (request) {
    if (self._unhooked) {
      // if the patched require function could not be removed because
      // someone else patched it after it was patched here, we just
      // abort and pass the request onwards to the original require
      return self._origRequire.apply(this, arguments)
    }

    const filename = Module._resolveFilename(request, this)
    const core = filename.indexOf(path.sep) === -1
    let name, basedir

    // return known patched modules immediately
    if (self.cache.hasOwnProperty(filename)) {
      // require.cache was potentially altered externally
      if (require.cache[filename] && require.cache[filename].exports !== self.cache[filename].original) {
        return require.cache[filename].exports
      }

      return self.cache[filename].exports
    }

    // Check if this module has a patcher in-progress already.
    // Otherwise, mark this module as patching in-progress.
    const patched = patching[filename]
    if (!patched) {
      patching[filename] = true
    }

    const exports = self._origRequire.apply(this, arguments)

    // If it's already patched, just return it as-is.
    if (patched) return exports

    // The module has already been loaded,
    // so the patching mark can be cleaned up.
    delete patching[filename]

    if (core) {
      if (modules && modules.indexOf(filename) === -1) return exports // abort if module name isn't on whitelist
      name = filename
    } else {
      const stat = parse(filename)
      if (!stat) return exports // abort if filename could not be parsed
      name = stat.name
      basedir = stat.basedir

      if (modules && modules.indexOf(name) === -1) return exports // abort if module name isn't on whitelist

      // figure out if this is the main module file, or a file inside the module
      const paths = Module._resolveLookupPaths(name, this, true)
      if (!paths) {
        // abort if _resolveLookupPaths return null
        return exports
      }
      const res = Module._findPath(name, [basedir, ...paths])
      if (res !== filename) {
        // this is a module-internal file
        // use the module-relative path to the file, prefixed by original module name
        name = name + path.sep + path.relative(basedir, filename)
      }
    }

    // ensure that the cache entry is assigned a value before calling
    // onrequire, in case calling onrequire requires the same module.
    self.cache[filename] = { exports }
    self.cache[filename].original = exports
    self.cache[filename].exports = onrequire(exports, name, basedir)

    return self.cache[filename].exports
  }
}
