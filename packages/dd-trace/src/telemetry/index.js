'use strict'

let telemetry

// Lazy load the telemetry module to avoid the performance impact of loading it unconditionally
module.exports = {
  start (config, ...args) {
    if (!config.telemetry.enabled) return
    telemetry ??= require('./telemetry')
    telemetry.start(config, ...args)
  },
  // This might be called before `start` so we have to trigger loading the
  // underlying module here as well.
  updateConfig (changes, config, ...args) {
    if (!config.telemetry.enabled) return
    telemetry ??= require('./telemetry')
    telemetry.updateConfig(changes, config, ...args)
  },
  updateIntegrations () {
    telemetry?.updateIntegrations()
  },
  appClosing () {
    telemetry?.appClosing()
  },
}
