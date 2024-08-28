'use strict'

const { monitorEventLoopDelay } = require('node:perf_hooks')
const StatsD = require('./statsd')
const statsd = new StatsD()

const histogram = monitorEventLoopDelay({ resolution: 1 })

histogram.enable()

process.on('beforeExit', () => {
  histogram.disable()

  statsd.gauge('event_loop.delay.max', histogram.max)
  statsd.flush()
})
