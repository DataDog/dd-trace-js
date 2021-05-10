'use strict'

const path = require('path')
const Module = require('module')
const parse = require('module-details-from-path')

const orig = Module.prototype.require

module.exports = function hook (modules, onrequire) {
  hook.cache = {}

  const patching = {}

  Module.prototype.require = function (request) {
    const filename = Module._resolveFilename(request, this)
    const core = filename.indexOf(path.sep) === -1
    let name, basedir

    // return known patched modules immediately
    if (hook.cache.hasOwnProperty(filename)) {
      return hook.cache[filename]
    }

    // Check if this module has a patcher in-progress already.
    // Otherwise, mark this module as patching in-progress.
    const patched = patching[filename]
    if (!patched) {
      patching[filename] = true
    }

    const exports = orig.apply(this, arguments)

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
      const res = Module._findPath(name, [basedir, ...Module._resolveLookupPaths(name, this, true)])
      if (res !== filename) {
        // this is a module-internal file
        // use the module-relative path to the file, prefixed by original module name
        name = name + path.sep + path.relative(basedir, filename)
      }
    }

    // only call onrequire the first time a module is loaded
    if (!hook.cache.hasOwnProperty(filename)) {
      // ensure that the cache entry is assigned a value before calling
      // onrequire, in case calling onrequire requires the same module.
      hook.cache[filename] = exports
      hook.cache[filename] = onrequire(exports, name, basedir)
    }

    return hook.cache[filename]
  }
}
