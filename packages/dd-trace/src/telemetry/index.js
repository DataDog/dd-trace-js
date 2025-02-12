'use strict'

const inactive = {
  start (config, ...args) {
    if (!config?.telemetry?.enabled) return

    const active = require('./telemetry')

    Object.setPrototypeOf(module.exports, active).start(config, ...args)
  },
  stop () {},
  updateConfig () {},
  updateIntegrations () {},
  appClosing () {}
}

module.exports = Object.setPrototypeOf({}, inactive)
