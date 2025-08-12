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
  decrement () {}
}

module.exports = {
  start (config) {
    if (!config?.runtimeMetrics.enabled) return

    runtimeMetrics = require('./runtime_metrics')

    Object.setPrototypeOf(module.exports, runtimeMetrics)

    runtimeMetrics.start(config)
  },

  stop () {
    runtimeMetrics.stop()

    Object.setPrototypeOf(module.exports, runtimeMetrics = noop)
  }
}

Object.setPrototypeOf(module.exports, noop)
