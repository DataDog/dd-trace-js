'use strict'

const plugins = require('./plugins')

const enabled = []

function enablePlugins (tracer, config) {
  for (const plugin in plugins) {
    const Plugin = plugins[plugin]
    const obj = new Plugin(tracer, config)
    obj.configure({ enabled: true })
    enabled.push(obj)
  }
}

function disablePlugins () {
  enabled.forEach((plugin, i) => {
    plugin.configure(false)
    enabled[i] = undefined
  })
}

module.exports = {
  enablePlugins,
  disablePlugins
}
