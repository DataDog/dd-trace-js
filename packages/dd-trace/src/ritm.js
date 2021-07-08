'use strict'

const path = require('path')
const Module = require('module')
const parse = require('module-details-from-path')

module.exports = function hook (modules, onrequire) {
  if (!hook.orig) {
    hook.orig = Module.prototype.require

    Module.prototype.require = function (request) {
      return hook.require.apply(this, arguments)
    }
  }

  hook.cache = {}

  const patching = {}

  hook.require = function (request) {
    const filename = Module._resolveFilename(request, this)
    const core = filename.indexOf(path.sep) === -1
    let name, basedir

    // return known patched modules immediately
    if (hook.cache.hasOwnProperty(filename)) {
      // require.cache was potentially altered externally
      if (require.cache[filename] && require.cache[filename].exports !== hook.cache[filename].original) {
        return require.cache[filename].exports
      }

      return hook.cache[filename].exports
    }

    // Check if this module has a patcher in-progress already.
    // Otherwise, mark this module as patching in-progress.
    const patched = patching[filename]
    if (!patched) {
      patching[filename] = true
    }

    const exports = hook.orig.apply(this, arguments)

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
    hook.cache[filename] = { exports }
    hook.cache[filename].original = exports
    hook.cache[filename].exports = onrequire(exports, name, basedir)

    return hook.cache[filename].exports
  }
}
