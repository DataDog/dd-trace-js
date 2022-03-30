'use strict'

const dc = require('diagnostics_channel')
const path = require('path')
const semver = require('semver')
const iitm = require('../../../dd-trace/src/iitm')
const ritm = require('../../../dd-trace/src/ritm')
const parse = require('module-details-from-path')
const requirePackageJson = require('../../../dd-trace/src/require-package-json')
const { AsyncResource } = require('async_hooks')

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
  const fullFilename = filename(name, file)
  const loaderHook = (moduleExports, moduleName, moduleBaseDir) => {
    moduleName = moduleName.replace(pathSepExpr, '/')
    if (moduleName !== fullFilename || !matchVersion(getVersion(moduleBaseDir), versions)) {
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
      if (!id.endsWith(`/node_modules/${filename(instrumentation.name, instrumentation.file)}`)) continue

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

// AsyncResource.bind exists and binds `this` properly only from 17.8.0 and up.
// https://nodejs.org/api/async_context.html#asyncresourcebindfn-thisarg
if (semver.satisfies(process.versions.node, '>=17.8.0')) {
  exports.AsyncResource = AsyncResource
} else {
  exports.AsyncResource = class extends AsyncResource {
    static bind (fn, type, thisArg) {
      type = type || fn.name
      return (new exports.AsyncResource(type || 'bound-anonymous-fn')).bind(fn, thisArg)
    }

    bind (fn, thisArg) {
      let bound
      if (thisArg === undefined) {
        const resource = this
        bound = function (...args) {
          args.unshift(fn, this)
          return Reflect.apply(resource.runInAsyncScope, resource, args)
        }
      } else {
        bound = this.runInAsyncScope.bind(this, fn, thisArg)
      }
      Object.defineProperties(bound, {
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
      return bound
    }
  }
}
