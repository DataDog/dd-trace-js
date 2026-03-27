'use strict'

let runtimeMetrics

const noop = runtimeMetrics = {
  stop () {},
  track () {},
  boolean () {},
  histogram () {},
  count () {},
  gauge () {},
  increment () {},
  decrement () {},
}

module.exports = {
  start (config) {
    if (!config?.runtimeMetrics.enabled) return

    if (config.otelMetricsEnabled) {
      // Use OTLP runtime metrics with OTel-native naming (v8js.*, nodejs.*, process.*)
      // when the OTel metrics pipeline is active. DogStatsD runtime metrics are skipped
      // to avoid double-reporting.
      runtimeMetrics = require('./otlp_runtime_metrics')
    } else {
      runtimeMetrics = require('./runtime_metrics')
    }

    Object.setPrototypeOf(module.exports, runtimeMetrics)

    runtimeMetrics.start(config)
  },

  stop () {
    runtimeMetrics.stop()

    Object.setPrototypeOf(module.exports, runtimeMetrics = noop)
  },
}

Object.setPrototypeOf(module.exports, noop)
