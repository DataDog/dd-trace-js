'use strict'

const path = require('path')
const Module = require('module')
const parse = require('../../../vendor/dist/module-details-from-path')
const dc = require('dc-polyfill')
const { getEnvironmentVariable } = require('../../dd-trace/src/config-helper')
const fs = require('fs')
const origRequire = Module.prototype.require

// derived from require-in-the-middle@3 with tweaks

module.exports = Hook

let moduleHooks = Object.create(null)
const pathModuleHooks = new Set()
let cache = Object.create(null)
let patching = Object.create(null)
let patchedRequire = null
const moduleLoadStartChannel = dc.channel('dd-trace:moduleLoadStart')
const moduleLoadEndChannel = dc.channel('dd-trace:moduleLoadEnd')

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

  modules = modules || []
  options = options || {}

  this.modules = modules
  this.options = options
  this.onrequire = onrequire

  if (Array.isArray(modules)) {
    for (const mod of modules) {
      const hooks = moduleHooks[mod]

      if (hooks) {
        hooks.push(onrequire)
      } else {
        if (path.isAbsolute(mod)) pathModuleHooks.add(mod)
        moduleHooks[mod] = [onrequire]
      }
    }
  }

  if (patchedRequire) return

  const _origRequire = Module.prototype.require
  patchedRequire = Module.prototype.require = function (request) {
    /*
    If resolving the filename for a `require(...)` fails, defer to the wrapped
    require implementation rather than failing right away. This allows a
    possibly monkey patched `require` to work.
    */
    let filename
    try {
      filename = Module._resolveFilename(request, this)
    } catch {
      return _origRequire.apply(this, arguments)
    }
    const core = !filename.includes(path.sep)
    let name, basedir, hooks
    // return known patched modules immediately
    if (cache[filename]) {
      // require.cache was potentially altered externally
      if (require.cache[filename] && require.cache[filename].exports !== cache[filename].original) {
        return require.cache[filename].exports
      }

      return cache[filename].exports
    }

    // Check if this module has a patcher in-progress already.
    // Otherwise, mark this module as patching in-progress.
    const patched = patching[filename]
    if (patched) {
      // If it's already patched, just return it as-is.
      return origRequire.apply(this, arguments)
    }
    patching[filename] = true

    const payload = {
      filename,
      request
    }

    if (moduleLoadStartChannel.hasSubscribers) {
      moduleLoadStartChannel.publish(payload)
    }
    let exports = origRequire.apply(this, arguments)
    payload.module = exports
    if (moduleLoadEndChannel.hasSubscribers) {
      moduleLoadEndChannel.publish(payload)
      exports = payload.module
    }

    // The module has already been loaded,
    // so the patching mark can be cleaned up.
    delete patching[filename]
    const isRelativeHook = isFilePath(request) && moduleHooks[request]
    if (core) {
      hooks = moduleHooks[filename]
      if (!hooks) return exports // abort if module name isn't on whitelist
      name = filename
    } else {
      const inAWSLambda = getEnvironmentVariable('AWS_LAMBDA_FUNCTION_NAME') !== undefined
      const hasLambdaHandler = getEnvironmentVariable('DD_LAMBDA_HANDLER') !== undefined
      const segments = filename.split(path.sep)
      const filenameFromNodeModule = segments.includes('node_modules')
      // decide how to assign the stat
      // first case will only happen when patching an AWS Lambda Handler
      const stat = inAWSLambda && hasLambdaHandler && !filenameFromNodeModule ? { name: filename } : parse(filename)

      if (stat) {
        name = stat.name
        basedir = stat.basedir

        hooks = moduleHooks[name]
        if (!hooks) return exports // abort if module name isn't on whitelist
      } else {
        // check if the full filename if the filename was registered, if not then prefix matching will be done
        hooks = moduleHooks[filename]

        if (!hooks && isRelativeHook) {
          hooks = moduleHooks[request]
          name = request
          basedir = findProjectRoot(filename)
        }

        if (!hooks) return exports // abort if filename isn't on whitelist

        if (!name) {
          name = filename
          basedir = path.dirname(filename)
        }
      }

      // figure out if this is the main module file, or a file inside the module
      // Skip this for paths since it's intended for node_modules paths

      if (!isRelativeHook) {
        const paths = Module._resolveLookupPaths(name, this, true)
        if (!paths) {
          // abort if _resolveLookupPaths return null
          return exports
        }

        let res
        try {
          res = Module._findPath(name, [basedir, ...paths])
        } catch {
          // case where the file specified in package.json "main" doesn't exist
          // in this case, the file is treated as module-internal
        }

        if (!res || res !== filename) {
          // this is a module-internal file
          // use the module-relative path to the file, prefixed by original module name
          name = name + path.sep + path.relative(basedir, filename)
        }
      }
    }

    // ensure that the cache entry is assigned a value before calling
    // onrequire, in case calling onrequire requires the same module.
    cache[filename] = { exports }
    cache[filename].original = exports

    for (const hook of hooks) {
      cache[filename].exports = hook(cache[filename].exports, name, basedir)
    }

    return cache[filename].exports
  }
}

Hook.reset = function () {
  Module.prototype.require = origRequire
  patchedRequire = null
  patching = Object.create(null)
  cache = Object.create(null)
  moduleHooks = Object.create(null)
}

function isFilePath (moduleName) {
  if (moduleName.startsWith('./') || moduleName.startsWith('../') || moduleName.startsWith('/')) {
    return true
  }

  if (moduleName.includes('/') && !moduleName.includes('node_modules/') && !moduleName.startsWith('@')) {
    return true
  }

  return false
}

function findProjectRoot(startDir) {
  let dir = startDir;

  while (!fs.existsSync(path.join(dir, 'package.json'))) {
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }

  return dir;
}

Hook.prototype.unhook = function () {
  for (const mod of this.modules) {
    const hooks = (moduleHooks[mod] || []).filter(hook => hook !== this.onrequire)

    if (hooks.length > 0) {
      moduleHooks[mod] = hooks
    } else {
      delete moduleHooks[mod]
    }
  }

  if (Object.keys(moduleHooks).length === 0) {
    Hook.reset()
  }
}
