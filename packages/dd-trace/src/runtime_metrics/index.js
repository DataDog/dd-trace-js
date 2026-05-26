'use strict'

const log = require('../log')

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

    runtimeMetrics = config.DD_METRICS_OTEL_ENABLED
      ? require('./otlp_runtime_metrics')
      : require('./runtime_metrics')

    Object.setPrototypeOf(module.exports, runtimeMetrics)

    try {
      runtimeMetrics.start(config)
    } catch (err) {
      // Unwind whatever managed to register so a partial init doesn't leak into the next start().
      runtimeMetrics.stop()
      log.error('Failed to start runtime metrics', err)
    }
  },

  stop () {
    runtimeMetrics.stop()
    runtimeMetrics = noop
    Object.setPrototypeOf(module.exports, noop)
  },
}

Object.setPrototypeOf(module.exports, noop)
