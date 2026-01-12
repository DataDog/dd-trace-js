'use strict'

const Plugin = require('./plugin')

class CompositePlugin extends Plugin {
  constructor (...args) {
    super(...args)

    console.log('[DEBUG COMPOSITE] Constructor called for', this.constructor.name)
    console.log('[DEBUG COMPOSITE] Plugins:', Object.keys(this.constructor.plugins))
    
    for (const [name, PluginClass] of Object.entries(this.constructor.plugins)) {
      console.log('[DEBUG COMPOSITE] Creating plugin:', name, 'PluginClass:', typeof PluginClass, PluginClass?.name)
      this[name] = new PluginClass(...args)
      console.log('[DEBUG COMPOSITE] Created plugin:', name, 'instance:', typeof this[name])
    }
  }

  /**
   * @override
   */
  configure (config) {
    super.configure(config)
    console.log('[DEBUG COMPOSITE] Configure called for', this.constructor.name)
    console.log('[DEBUG COMPOSITE] Config:', config)
    console.log('[DEBUG COMPOSITE] this.constructor.plugins:', Object.keys(this.constructor.plugins))
    
    for (const name in this.constructor.plugins) {
      console.log('[DEBUG COMPOSITE] Configuring plugin:', name, 'this[name] =', typeof this[name], this[name])
      const pluginConfig = config[name] === false
        ? false
        : { ...config, ...config[name] }

      this[name].configure(pluginConfig)
    }
  }
}

module.exports = CompositePlugin
