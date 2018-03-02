'use strict'

const requireDir = require('require-dir')

class Instrumenter {
  constructor (config) {
    this._plugins = loadPlugins(config)
  }

  patch (tracer) {
    this._plugins.forEach(plugin => {
      plugin.patch(require(plugin.name), tracer)
    })
  }

  unpatch (tracer) {
    this._plugins.forEach(plugin => {
      plugin.unpatch(require(plugin.name), tracer)
    })
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

module.exports = Instrumenter
