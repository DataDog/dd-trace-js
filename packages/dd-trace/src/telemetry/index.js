'use strict'

const activate = () => {
  const active = require('./telemetry')

  return Object.setPrototypeOf(module.exports, active)
}

const inactive = {
  start (config, ...args) {
    return config?.telemetry?.enabled && activate().start(config, ...args)
  },
  stop () {},
  // This might be called before `start` so we have to trigger loading the
  // underlying module here as well.
  updateConfig (changes, config, ...args) {
    return config?.telemetry?.enabled && activate().updateConfig(changes, config, ...args)
  },
  updateIntegrations () {},
  appClosing () {}
}

module.exports = Object.setPrototypeOf({}, inactive)
