'use strict'

const requireDir = require('require-dir')
const path = require('path')
const semver = require('semver')
const hook = require('require-in-the-middle')

// TODO: lazy load built-in plugins

class Instrumenter {
  constructor (tracer) {
    this._tracer = tracer
    this._integrations = loadIntegrations()
    this._plugins = new Map()
    this._instrumented = new Map()
  }

  use (name, config) {
    config = config || {}

    if (typeof name === 'string') {
      this._integrations
        .filter(plugin => plugin.name === name)
        .forEach(plugin => this._plugins.set(plugin, config))
    } else {
      [].concat(name)
        .forEach(plugin => this._plugins.set(plugin, config))
    }

    this.reload()
  }

  patch (config) {
    config = config || {}

    if (config.plugins !== false) {
      loadIntegrations().forEach(integration => {
        this._plugins.has(integration) || this._plugins.set(integration)
      })
    }

    this.reload()
  }

  unpatch () {
    this._instrumented.forEach((instrumentation, moduleExports) => {
      instrumentation.unpatch(moduleExports)
    })
  }

  reload () {
    const instrumentedModules = Array.from(this._plugins.keys()).map(plugin => plugin.name)
    hook(instrumentedModules, this.hookModule.bind(this))
  }

  hookModule (moduleExports, moduleName, moduleBaseDir) {
    const moduleVersion = getVersion(moduleBaseDir)

    Array.from(this._plugins.keys())
      .filter(plugin => plugin.name === moduleName)
      .filter(plugin => matchVersion(moduleVersion, plugin.versions))
      .forEach(plugin => {
        let moduleToPatch = moduleExports
        if (plugin.file) {
          moduleToPatch = require(path.join(moduleBaseDir, plugin.file))
        }
        plugin.patch(moduleToPatch, this._tracer._tracer, this._plugins.get(plugin))
        this._instrumented.set(moduleToPatch, plugin)
      })

    return moduleExports
  }
}

function loadIntegrations () {
  const integrations = requireDir('./plugins')

  return Object.keys(integrations)
    .map(key => integrations[key])
    .reduce((previous, current) => previous.concat(current), [])
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
