'use strict'

const requireDir = require('require-dir')

class Instrumenter {
  constructor (tracer, config) {
    this._tracer = tracer
    this._plugins = loadPlugins(config)
  }

  patch () {
    this._plugins.forEach(plugin => {
      plugin.patch(require(plugin.name), this._tracer)
    })
  }

  unpatch () {
    this._plugins.forEach(plugin => {
      plugin.unpatch(require(plugin.name))
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
