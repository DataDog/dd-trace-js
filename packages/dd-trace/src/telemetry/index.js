'use strict'

let telemetry

const noop = telemetry = {
  start () {},
  stop () {},
  updateConfig () {},
  updateIntegrations () {},
  appClosing () {}
}

module.exports = {
  start (config, ...args) {
    if (!config?.telemetry?.enabled) return

    telemetry = require('./telemetry')
    telemetry.start(config, ...args)
  },

  stop: () => {
    if (telemetry === noop) return

    telemetry.stop()
    telemetry = noop
  },

  updateIntegrations: (...args) => telemetry.updateIntegrations(...args),

  updateConfig: (changes, config, ...args) => {
    if (!config?.telemetry?.enabled) return
    if (telemetry === noop) {
      telemetry = require('./telemetry')
    }

    telemetry.updateConfig(changes, config, ...args)
  },

  appClosing: (...args) => telemetry.appClosing(...args)
}
