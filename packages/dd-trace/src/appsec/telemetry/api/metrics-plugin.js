'use strict'

const log = require('../../../log')
const TelemetryPlugin = require('./plugin')

class MetricsTelemetryPlugin extends TelemetryPlugin {
  constructor () {
    super('generate-metrics') // and also distributions
  }

  init (config, onStartCallback) {
    this.heartbeatInterval = config && config.metricsInterval
    super.init(config, onStartCallback)
  }

  getPayload () {
    const metricSeries = []
    const distributionSeries = []

    this.providers.forEach(drainProvider => {
      const metrics = drainProvider()
      if (!metrics) return

      for (const metric of metrics) {
        if (metric.type === 'distribution') {
          distributionSeries.push(metric)
        } else {
          metricSeries.push(metric)
        }
      }
    })
    if (metricSeries.length > 0 || distributionSeries.length > 0) {
      return {
        'generate-metrics': metricSeries,
        'distributions': distributionSeries
      }
    }
  }

  onSendData () {
    try {
      const payload = this.getPayload()
      if (!payload) return

      for (const reqType in payload) {
        const series = payload[reqType]
        if (series.length > 0) {
          this.send(reqType, {
            namespace: 'tracers',
            series
          })
        }
      }
    } catch (e) {
      log.error(e)
    }
  }
}

module.exports = new MetricsTelemetryPlugin()
