'use strict'

const dc = require('diagnostics_channel')
const path = require('path')
const semver = require('semver')
const iitm = require('../../../dd-trace/src/iitm')
const ritm = require('../../../dd-trace/src/ritm')
const parse = require('module-details-from-path')
const requirePackageJson = require('../../../dd-trace/src/require-package-json')
const { AsyncResource, executionAsyncId, triggerAsyncId } = require('async_hooks')
const shimmer = require('../../../datadog-shimmer')
const storage = require('../../../datadog-core').storage


const pathSepExpr = new RegExp(`\\${path.sep}`, 'g')
const channelMap = {}
exports.channel = function channel (name) {
  const maybe = channelMap[name]
  if (maybe) return maybe
  const ch = dc.channel(name)
  channelMap[name] = ch
  return ch
}

exports.addHook = function addHook ({ name, versions, file }, hook) {
  file = filename(name, file)
  const loaderHook = (moduleExports, moduleName, moduleBaseDir) => {
    moduleName = moduleName.replace(pathSepExpr, '/')
    const moduleVersion = getVersion(moduleBaseDir)
    if (moduleName !== file || !matchVersion(moduleVersion, versions)) {
      return moduleExports
    }
    return hook(moduleExports)
  }
  ritm([name], loaderHook)
  cjsPostLoad({ name, versions, file }, hook)
  iitm([name], loaderHook)
}

function matchVersion (version, ranges) {
  return !version || (ranges && ranges.some(range => semver.satisfies(semver.coerce(version), range)))
}

function getVersion (moduleBaseDir) {
  if (moduleBaseDir) {
    return requirePackageJson(moduleBaseDir, module).version
  }
}

function filename (name, file) {
  return [name, file].filter(val => val).join('/')
}

// TODO this is basically Loader#_getModules + running the hook. DRY up.
function cjsPostLoad (instrumentation, hook) {
  const ids = Object.keys(require.cache)

  let pkg

  for (let i = 0, l = ids.length; i < l; i++) {
    if (ids[i] === instrumentation.name) {
      hook(require.cache[ids[i]].exports)
      continue
    }

    const id = ids[i].replace(pathSepExpr, '/')

    if (!id.includes(`/node_modules/${instrumentation.name}/`)) continue

    if (instrumentation.file) {
      if (!id.endsWith(`/node_modules/${filename(instrumentation)}`)) continue

      const basedir = getBasedir(ids[i])

      pkg = requirePackageJson(basedir, module)
    } else {
      const basedir = getBasedir(ids[i])

      pkg = requirePackageJson(basedir, module)

      const mainFile = path.posix.normalize(pkg.main || 'index.js')
      if (!id.endsWith(`/node_modules/${instrumentation.name}/${mainFile}`)) continue
    }

    if (!matchVersion(pkg.version, instrumentation.versions)) continue

    hook(require.cache[ids[i]].exports)
  }
}

function getBasedir (id) {
  return parse(id).basedir.replace(pathSepExpr, '/')
}

if (semver.satisfies(process.versions.node, '>=16.0.0')) {
  exports.AsyncResource = AsyncResource
} else {
  exports.AsyncResource = class extends AsyncResource {
    static bind (fn, type, thisArg) {
      type = type || fn.name
      return (new exports.AsyncResource(type || 'bound-anonymous-fn')).bind(fn, thisArg)
    }

    bind (fn, thisArg = this) {
      const ret = this.runInAsyncScope.bind(this, fn, thisArg)
      Object.defineProperties(ret, {
        'length': {
          configurable: true,
          enumerable: false,
          value: fn.length,
          writable: false
        },
        'asyncResource': {
          configurable: true,
          enumerable: true,
          value: this,
          writable: true
        }
      })
      return ret
    }
  }
}

exports.bindEventEmitter = function bindEventEmitter (emitter) {
  
  shimmer.wrap(emitter, 'addListener', wrapAddListener)
  shimmer.wrap(emitter, 'prependListener', wrapAddListener)
  shimmer.wrap(emitter, 'on', wrapAddListener)
  shimmer.wrap(emitter, 'once', wrapAddListener)
  shimmer.wrap(emitter, 'removeListener', wrapRemoveListener)
  shimmer.wrap(emitter, 'off', wrapRemoveListener)
  shimmer.wrap(emitter, 'removeAllListeners', wrapRemoveAllListener)
  emitter.__is_dd_emitter = true
}

function wrapAddListener (addListener) {
  return function (name, fn) {
    const ar = new AsyncResource('bound-anonymous-fn')
    const bound = function () {
      return ar.runInAsyncScope(() => {
        return fn.apply(this, arguments)
      })
    }
    bound._datadog_unbound = fn
    this._datadog_events = this._datadog_events || {}
    if (!this._datadog_events[name]) {
      this._datadog_events[name] = new Map()
    }
    this._datadog_events[name].set(fn, bound)
    addListener.call(this, name, bound)
  }
}

function wrapRemoveListener (removeListener) {
  return function (name, fn) {
    const listeners = this._datadog_events && this._datadog_events[name]
    const bound = listeners.get(fn)
    listeners.delete(fn)
    removeListener.call(this, name, bound)
  }
}

function wrapRemoveAllListener (removeAllListeners) {
  return function (name, fn) {
    const listeners = this._datadog_events && this._datadog_events[name]
    const bound = listeners.get(fn)
    listeners.delete(fn)
    if (name) {
      delete this._datadog_events[name]
    } else {
      delete this._datadog_events
    }
    removeAllListeners.call(this, name, bound)
  }
}

exports.bindEmit = function bindEmit (emitter, errorChn1qlReq, asyncEndChn1qlReq) {
  // debugger;
  // shimmer.wrap(emitter, 'addListener', wrapAddListener)
  // shimmer.wrap(emitter, 'prependListener', wrapAddListener)
  // shimmer.wrap(emitter, 'on', wrapAddListener)
  // shimmer.wrap(emitter, 'once', wrapAddListener)
  // shimmer.wrap(emitter, 'removeListener', wrapRemoveListener)
  // shimmer.wrap(emitter, 'off', wrapRemoveListener)
  // shimmer.wrap(emitter, 'removeAllListeners', wrapRemoveAllListener)
  // emitter.__is_dd_emitter = true
  console.log(1, storage.getStore())
  const asyncResource = new AsyncResource('bound-anonymous-fn')
  shimmer.wrap(emitter, 'emit', emit => function (eventName, ...args) {
    debugger;
    const id = executionAsyncId()
    
    // const oldEmit = asyncResource.bind(emit)
    // // console.log(id)
    // return emitter.emit = exports.bind(function() {
      
    //   return oldEmit.apply(emitter, arguments);
    // })

    

    return asyncResource.runInAsyncScope(() => {
      // console.log(3, storage.getStore())
      debugger;

      console.log(arguments)
      // errorChn1qlReq.publish(error)
      // asyncEndChn1qlReq.publish(undefined)


      console.log(id, triggerAsyncId())
      const res = emit.apply(this, arguments)
      
      return res
    })
  })
}