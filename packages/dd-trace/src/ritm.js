'use strict'

const path = require('path')
const fs = require('fs')
const Module = require('module')

const dc = require('dc-polyfill')

const parse = require('../../../vendor/dist/module-details-from-path')
const { isRelativeRequire } = require('../../datadog-instrumentations/src/helpers/shared-utils')
const { getEnvironmentVariable, getValueFromEnvSources } = require('./config/helper')

const origRequire = Module.prototype.require
// derived from require-in-the-middle@3 with tweaks

module.exports = Hook

let moduleHooks = Object.create(null)
let cache = Object.create(null)
let patching = Object.create(null)
let patchedRequire = null
const moduleLoadStartChannel = dc.channel('dd-trace:moduleLoadStart')
const moduleLoadEndChannel = dc.channel('dd-trace:moduleLoadEnd')

function stripNodePrefix (name) {
  if (typeof name !== 'string') return name
  return name.startsWith('node:') ? name.slice(5) : name
}

const builtinModules = new Set(Module.builtinModules.map(stripNodePrefix))

function isBuiltinModuleName (name) {
  if (typeof name !== 'string') return false
  return builtinModules.has(stripNodePrefix(name))
}

function normalizeModuleName (name) {
  if (typeof name !== 'string') return name
  const stripped = stripNodePrefix(name)
  return builtinModules.has(stripped) ? stripped : name
}

/**
 * @overload
 * @param {string[]} modules list of modules to hook into
 * @param {object} options hook options
 * @param {Function} onrequire callback to be executed upon encountering module
 */
/**
 * @overload
 * @param {string[]} modules list of modules to hook into
 * @param {Function} onrequire callback to be executed upon encountering module
 */
function Hook (modules, options, onrequire) {
  if (!(this instanceof Hook)) return new Hook(modules, options, onrequire)
  if (typeof options === 'function') {
    onrequire = options
    options = {}
  }

  modules ??= []
  options ??= {}

  this.modules = modules
  this.options = options
  this.onrequire = onrequire

  if (Array.isArray(modules)) {
    for (const mod of modules) {
      const hooks = moduleHooks[mod]

      if (hooks) {
        hooks.push(onrequire)
      } else {
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
      // @ts-expect-error - Module._resolveFilename is not typed
      filename = Module._resolveFilename(request, this)
    } catch {
      return _origRequire.apply(this, arguments)
    }

    const builtin = isBuiltinModuleName(filename)
    const moduleId = builtin ? normalizeModuleName(filename) : filename
    let name, basedir, hooks
    // return known patched modules immediately
    if (cache[moduleId]) {
      // require.cache was potentially altered externally
      const cacheEntry = require.cache[filename]
      if (cacheEntry && cacheEntry.exports !== cache[filename].original) {
        return cacheEntry.exports
      }

      return cache[moduleId].exports
    }

    // Check if this module has a patcher in-progress already.
    // Otherwise, mark this module as patching in-progress.
    const patched = patching[moduleId]
    if (patched) {
      // If it's already patched, just return it as-is.
      return origRequire.apply(this, arguments)
    }
    patching[moduleId] = true

    const payload = {
      filename,
      request,
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
    delete patching[moduleId]

    if (builtin) {
      hooks = moduleHooks[moduleId]
      if (!hooks) return exports // abort if module name isn't on whitelist
      name = moduleId
    } else {
      const inAWSLambda = getEnvironmentVariable('AWS_LAMBDA_FUNCTION_NAME') !== undefined
      const hasLambdaHandler = getValueFromEnvSources('DD_LAMBDA_HANDLER') !== undefined
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

        // figure out if this is the main module file, or a file inside the module
        // @ts-expect-error - Module._resolveLookupPaths is meant to be internal and is not typed
        const paths = Module._resolveLookupPaths(name, this, true)
        if (!paths) {
          // abort if _resolveLookupPaths return null
          return exports
        }

        let res
        try {
          // @ts-expect-error - Module._findPath is meant to be internal and is not typed
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
      } else {
        if (isRelativeRequire(request) && moduleHooks[request]) {
          hooks = moduleHooks[request]
          name = request
          basedir = findProjectRoot(filename)
        }

        if (!hooks) return exports
      }
    }

    // ensure that the cache entry is assigned a value before calling
    // onrequire, in case calling onrequire requires the same module.
    cache[moduleId] = { exports }
    cache[moduleId].original = exports

    for (const hook of hooks) {
      cache[moduleId].exports = hook(cache[moduleId].exports, name, basedir)
    }

    return cache[moduleId].exports
  }
}

/**
 * Reset the Ritm hook. This is used to reset the hook after a test.
 * TODO: Remove this and instead use proxyquire to reset the hook.
 */
Hook.reset = function () {
  Module.prototype.require = origRequire
  patchedRequire = null
  patching = Object.create(null)
  cache = Object.create(null)
  moduleHooks = Object.create(null)
}

function findProjectRoot (startDir) {
  let dir = startDir

  while (!fs.existsSync(path.join(dir, 'package.json'))) {
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  return dir
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
