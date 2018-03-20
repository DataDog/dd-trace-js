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

  patch () {
    const instrumentedModules = this._plugins.map(plugin => plugin.name)
    hook(instrumentedModules, this.hookModule.bind(this))
  }

  unpatch () {
    this._instrumented.forEach((instrumentation, moduleExports) => {
      instrumentation.unpatch(moduleExports)
    })
  }

  hookModule (moduleExports, moduleName, moduleBaseDir) {
    const moduleVersion = getVersion(moduleBaseDir)

    this._plugins
      .filter(plugin => plugin.name === moduleName)
      .filter(plugin => matchVersion(moduleVersion, plugin.versions))
      .forEach(plugin => {
        plugin.patch(moduleExports, this._tracer)
        this._instrumented.set(moduleExports, plugin)
      })

    return moduleExports
  }
}

function loadPlugins (config) {
  if (config.plugins === false) {
    return []
  }

  const plugins = []
  const integrations = requireDir('./plugins')

  Object.keys(integrations).forEach(key => {
    plugins.push(integrations[key])
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
