'use strict'

const Plugin = require('./plugin')

class CompositePlugin extends Plugin {
  #pluginNames = []

  constructor (...args) {
    super(...args)

    for (const [name, PluginClass] of Object.entries(this.constructor.plugins)) {
      // Handle case where value is an array of plugin classes
      if (Array.isArray(PluginClass)) {
        for (const SinglePluginClass of PluginClass) {
          const pluginId = SinglePluginClass.id || name
          this[pluginId] = new SinglePluginClass(...args)
          this.#pluginNames.push(pluginId)
        }
      } else {
        this[name] = new PluginClass(...args)
        this.#pluginNames.push(name)
      }
    }
  }

  /**
   * @override
   */
  configure (config) {
    super.configure(config)
    for (const name of this.#pluginNames) {
      const pluginConfig = config[name] === false
        ? false
        : { ...config, ...config[name] }

      this[name].configure(pluginConfig)
    }
  }
}

module.exports = CompositePlugin
