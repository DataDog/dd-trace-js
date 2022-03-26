'use strict'

const semver = require('semver')
const Hook = require('../../datadog-instrumentations/src/helpers/hook')
const parse = require('module-details-from-path')
const path = require('path')
const uniq = require('lodash.uniq')
const log = require('./log')
const requirePackageJson = require('./require-package-json')

const pathSepExpr = new RegExp(`\\${path.sep}`, 'g')

class Loader {
  constructor (instrumenter) {
    this._instrumenter = instrumenter
  }

  reload (plugins) {
    this._plugins = plugins
    this._patched = []

    const instrumentations = Array.from(this._plugins.keys())
      .reduce((prev, current) => prev.concat(current), [])

    const instrumentedModules = uniq(instrumentations
      .map(instrumentation => instrumentation.name))

    this._names = new Set(instrumentations
      .map(instrumentation => filename(instrumentation)))

    this._hook && this._hook.unhook()
    this._hook = Hook(instrumentedModules, (moduleExports, moduleName, moduleBaseDir) => {
      return this._hookModule(moduleExports, moduleName, moduleBaseDir)
    })
  }

  load (instrumentation, config) {
    this._getModules(instrumentation).forEach(nodule => {
      this._instrumenter.patch(instrumentation, nodule, config)
    })
  }

  _getModules (instrumentation) {
    const modules = []
    const ids = Object.keys(require.cache)

    let pkg

    for (let i = 0, l = ids.length; i < l; i++) {
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

      modules.push(require.cache[ids[i]].exports)
    }

    return modules
  }

  _hookModule (moduleExports, moduleName, moduleBaseDir) {
    moduleName = moduleName.replace(pathSepExpr, '/')

    if (!this._names.has(moduleName)) {
      return moduleExports
    }

    if (moduleBaseDir) {
      moduleBaseDir = moduleBaseDir.replace(pathSepExpr, '/')
    }

    const moduleVersion = getVersion(moduleBaseDir)

    for (const [plugin, meta] of this._plugins) {
      if (meta.config.enabled === false) {
        continue
      }
      try {
        for (const instrumentation of [].concat(plugin)) {
          if (moduleName !== filename(instrumentation) || !matchVersion(moduleVersion, instrumentation.versions)) {
            continue
          }

          moduleExports = this._instrumenter.patch(instrumentation, moduleExports, meta.config) || moduleExports
        }
      } catch (e) {
        log.error(e)
        this._instrumenter.unload(plugin)
        log.debug(`Error while trying to patch ${meta.name}. The plugin has been disabled.`)
      }
    }

    return moduleExports
  }
}

function getBasedir (id) {
  return parse(id).basedir.replace(pathSepExpr, '/')
}

function matchVersion (version, ranges) {
  return !version || (ranges && ranges.some(range => semver.satisfies(semver.coerce(version), range)))
}

function getVersion (moduleBaseDir) {
  if (moduleBaseDir) {
    return requirePackageJson(moduleBaseDir, module).version
  }
}

function filename (plugin) {
  return [plugin.name, plugin.file].filter(val => val).join('/')
}

module.exports = Loader
