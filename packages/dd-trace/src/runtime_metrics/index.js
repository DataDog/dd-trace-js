'use strict'

let runtimeMetrics

const noop = runtimeMetrics = {
  start () {},
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
    if (!config.runtimeMetrics.enabled) return

    runtimeMetrics = require('./runtime_metrics')
    runtimeMetrics.start(config)
  },

  stop: () => {
    if (runtimeMetrics === noop) return

    runtimeMetrics.stop()
    runtimeMetrics = noop
  },

  track: (...args) => runtimeMetrics.track(...args),
  boolean: (...args) => runtimeMetrics.boolean(...args),
  histogram: (...args) => runtimeMetrics.histogram(...args),
  count: (...args) => runtimeMetrics.count(...args),
  gauge: (...args) => runtimeMetrics.gauge(...args),
  increment: (...args) => runtimeMetrics.increment(...args),
  decrement: (...args) => runtimeMetrics.decrement(...args)
}
