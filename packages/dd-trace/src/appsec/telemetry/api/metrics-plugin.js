'use strict'

const TelemetryPlugin = require('./plugin')

class MetricsTelemetryPlugin extends TelemetryPlugin {
  constructor () {
    super('generate-metrics')
  }

  init (config, onStartCallback) {
    this.heartbeatInterval = config && config.metricsInterval
    super.init(config, onStartCallback)
  }

  getPayload () {
    const series = []
    this.providers.forEach(provider => {
      const metrics = provider()
      if (metrics) {
        series.push(...metrics)
      }
    })
    if (series.length > 0) {
      return {
        namespace: 'tracers',
        series
      }
    }
  }
}

module.exports = new MetricsTelemetryPlugin()
