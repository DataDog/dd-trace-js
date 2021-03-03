'use strict'

const { monitorEventLoopDelay } = require('perf_hooks')
const DogStatsD = require('./dogstatsd')
const statsd = new DogStatsD()

const histogram = monitorEventLoopDelay({ resolution: 1 })

histogram.enable()

process.on('beforeExit', () => {
  histogram.disable()

  statsd.gauge('event_loop.delay.max', histogram.max)
  statsd.flush()
})
