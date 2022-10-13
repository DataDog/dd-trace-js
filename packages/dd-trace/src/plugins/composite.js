'use strict'

const Plugin = require('./plugin')

class CompositePlugin extends Plugin {
  constructor (...args) {
    super(...args)

    for (const [name, PluginClass] of Object.entries(this.constructor.plugins)) {
      this[name] = new PluginClass(...args)
    }
  }

  configure (config) {
    for (const name in this.constructor.plugins) {
      const pluginConfig = config[name] === false ? false : {
        ...config,
        ...config[name]
      }

      this[name].configure(pluginConfig)
    }
  }
}

module.exports = CompositePlugin
