'use strict'

let telemetry

const noop = telemetry = {
  start () {},
  stop () {},
  updateIntegrations () {},
  updateConfig () {},
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
  updateConfig: (...args) => telemetry.updateConfig(...args),
  appClosing: (...args) => telemetry.appClosing(...args)
}
