'use strict'

const Plugin = require('./plugin')

class CompositePlugin extends Plugin {
  constructor (...args) {
    super(...args)

    // Track instantiated plugin names for configure()
    this._pluginNames = []

    for (const [name, PluginClass] of Object.entries(this.constructor.plugins)) {
      // Handle case where value is an array of plugin classes
      if (Array.isArray(PluginClass)) {
        for (const SinglePluginClass of PluginClass) {
          const pluginId = SinglePluginClass.id || name
          this[pluginId] = new SinglePluginClass(...args)
          this._pluginNames.push(pluginId)
        }
      } else {
        this[name] = new PluginClass(...args)
        this._pluginNames.push(name)
      }
    }
  }

  /**
   * @override
   */
  configure (config) {
    super.configure(config)
    for (const name of this._pluginNames) {
      const pluginConfig = config[name] === false
        ? false
        : { ...config, ...config[name] }

      this[name].configure(pluginConfig)
    }
  }
}

module.exports = CompositePlugin
