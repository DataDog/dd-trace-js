'use strict'

let telemetry

// Lazy load the telemetry module to avoid the performance impact of loading it unconditionally
module.exports = {
  start (config, ...args) {
    telemetry ??= require('./telemetry')
    telemetry.start(config, ...args)
  },
  stop () {
    telemetry?.stop()
  },
  // This might be called before `start` so we have to trigger loading the
  // underlying module here as well.
  updateConfig (changes, config, ...args) {
    telemetry ??= require('./telemetry')
    telemetry.updateConfig(changes, config, ...args)
  },
  updateIntegrations () {
    telemetry?.updateIntegrations()
  },
  appClosing () {
    telemetry?.appClosing()
  }
}
