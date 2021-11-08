'use strict'

const { isTrue } = require('./util')
const plugins = require('./plugins')

// instrument everything that needs Plugin System V2 instrumentation
require('../../datadog-instrumentations')


// TODO this is shared w/ instrumenter. DRY up.
function getConfig (name, config = {}) {
  if (!name) {
    return config
  }

  const enabled = process.env[`DD_TRACE_${name.toUpperCase()}_ENABLED`.replace(/[^a-z0-9_]/ig, '_')]
  if (enabled !== undefined) {
    config.enabled = isTrue(enabled)
  }

  // TODO is this the best/correct place for this default?
  if (!("enabled" in config)) {
    config.enabled = true
  }

  return config
}

// TODO actually ... should we be looking at envrionment variables this deep down in the code?

// TODO this must always be a singleton.
module.exports = class PluginManager {
  #pluginsByName

  constructor () {
    this.#pluginsByName = Object.values(plugins)
      .filter(p => typeof p === 'function')
      .reduce((acc, C) => Object.assign(acc, { [C.name]: new C() }), {})
  }

  // like instrumenter.use()
  configurePlugin (name, pluginConfig) {
    if (!(name in this.#pluginsByName)) return
    if (typeof pluginConfig === 'boolean') {
      pluginConfig = { enabled: pluginConfig }
    }

    this.#pluginsByName[name].configure(getConfig(name, pluginConfig))
  }

  // like instrumenter.enable()
  configure (config) {
    config = config || {}
    const serviceMapping = config.serviceMapping

    if (config.plugins !== false) {
      for (const name in this.#pluginsByName) {
        const pluginConfig = {}
        if (serviceMapping && serviceMapping[name]) {
          pluginConfig.service = serviceMapping[name]
        }
        this.configurePlugin(name, pluginConfig)
      }
    }
  }

  // This is basically just for testing. like intrumenter.disable()
  destroy() {
    for (const plugin of this.#pluginsByName) plugin.configure({ enabled: false })
  }
}
