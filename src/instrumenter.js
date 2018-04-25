'use strict'

const requireDir = require('require-dir')
const path = require('path')
const semver = require('semver')
const hook = require('require-in-the-middle')

class Instrumenter {
  constructor (tracer, config) {
    this._tracer = tracer
    this._plugins = loadPlugins(config)
    this._instrumented = new Map()
  }

  use (name, config) {
    Array.from(this._plugins.keys())
      .filter(plugin => plugin.name === name)
      .forEach(plugin => this._plugins.set(plugin, config || {}))
  }

  patch () {
    const instrumentedModules = Array.from(this._plugins.keys()).map(plugin => plugin.name)
    hook(instrumentedModules, this.hookModule.bind(this))
  }

  unpatch () {
    this._instrumented.forEach((instrumentation, moduleExports) => {
      instrumentation.unpatch(moduleExports)
    })
  }

  hookModule (moduleExports, moduleName, moduleBaseDir) {
    const moduleVersion = getVersion(moduleBaseDir)

    Array.from(this._plugins.keys())
      .filter(plugin => plugin.name === moduleName)
      .filter(plugin => matchVersion(moduleVersion, plugin.versions))
      .forEach(plugin => {
        if (plugin.file) {
          moduleExports = require(path.join(moduleBaseDir, plugin.file))
        }
        plugin.patch(moduleExports, this._tracer, this._plugins.get(plugin))
        this._instrumented.set(moduleExports, plugin)
      })

    return moduleExports
  }
}

function loadPlugins (config) {
  const plugins = new Map()

  if (config.plugins === false) {
    return plugins
  }

  const integrations = requireDir('./plugins')

  Object.keys(integrations)
    .map(key => integrations[key])
    .reduce((previous, current) => previous.concat(current), [])
    .forEach(integration => {
      plugins.set(integration, {})
    })

  return plugins
}

function matchVersion (version, ranges) {
  return !version || (ranges && ranges.some(range => semver.satisfies(version, range)))
}

function getVersion (moduleBaseDir) {
  if (moduleBaseDir) {
    const packageJSON = path.join(moduleBaseDir, 'package.json')
    return require(packageJSON).version
  }
}

module.exports = Instrumenter
