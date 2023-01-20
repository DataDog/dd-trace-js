'use strict'

const TelemetryPlugin = require('./plugin')

class LogsTelemetryPlugin extends TelemetryPlugin {
  constructor () {
    super('logs')
  }

  init (config, onStartCallback) {
    if (config.logCollection) {
      super.init(config, onStartCallback)
    }
  }

  getPayload () {
    const logs = []
    this.providers.forEach(provider => {
      const providerLogs = provider()
      if (providerLogs) {
        logs.push(...providerLogs)
      }
    })
    return logs.length > 0 ? logs : null
  }
}

module.exports = new LogsTelemetryPlugin()
