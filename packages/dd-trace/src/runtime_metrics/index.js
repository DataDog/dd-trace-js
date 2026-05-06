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
  /**
   * @param {import('../config/config-base')} config - Tracer configuration
   */
  start (config) {
    if (!config?.runtimeMetrics.enabled) return

    // Use OTLP runtime metrics with OTel-native naming when the OTel metrics
    // pipeline is active. DogStatsD runtime metrics are skipped to avoid double-reporting.
    runtimeMetrics = config.DD_METRICS_OTEL_ENABLED
      ? require('./otlp_runtime_metrics')
      : require('./runtime_metrics')

    Object.setPrototypeOf(module.exports, runtimeMetrics)

    runtimeMetrics.start(config)
  },

  stop () {
    runtimeMetrics.stop()

    Object.setPrototypeOf(module.exports, runtimeMetrics = noop)
  },
}

Object.setPrototypeOf(module.exports, noop)
