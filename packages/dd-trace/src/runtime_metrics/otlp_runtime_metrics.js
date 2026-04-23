'use strict'

// OTLP runtime metrics with OTel-native naming for Node.js
//
// OTel Node.js runtime metrics conventions:
// - v8js.memory.heap.* (V8 heap metrics)
// - nodejs.eventloop.delay.* (event loop delay)
// - process.cpu.utilization (CPU usage)
// - process.memory.usage (RSS memory)
//
// Uses per-instrument addCallback instead of addBatchObservableCallback
// because dd-trace-js custom MeterProvider does not support batch callbacks.

const v8 = require('node:v8')
const process = require('node:process')
const os = require('node:os')
const { performance, monitorEventLoopDelay } = require('node:perf_hooks')
const log = require('../log')

const METER_NAME = 'datadog.runtime_metrics'

let meter = null
let eventLoopHistogram = null
let lastCpuUsage = null
let lastTime = 0

module.exports = {
  start (config) {
    this.stop()

    try {
      const { metrics } = require('@opentelemetry/api')
      const meterProvider = metrics.getMeterProvider()

      if (!meterProvider) {
        log.error('OTLP runtime metrics: MeterProvider not available, OTel metrics pipeline may not be initialized.')
        return
      }

      meter = meterProvider.getMeter(METER_NAME)

      // Initialize CPU tracking
      lastCpuUsage = process.cpuUsage()
      lastTime = performance.now()

      // Initialize event loop delay monitoring
      const trackEventLoop = config.runtimeMetrics?.eventLoop !== false
      if (trackEventLoop && monitorEventLoopDelay) {
        eventLoopHistogram = monitorEventLoopDelay({ resolution: 4 })
        eventLoopHistogram.enable()
      }

      // --- V8 Heap Metrics ---
      const heapUsed = meter.createObservableGauge('v8js.memory.heap.used', {
        unit: 'By',
        description: 'V8 heap memory used.',
      })
      heapUsed.addCallback((result) => {
        const heapStats = v8.getHeapStatistics()
        result.observe(heapStats.used_heap_size)
      })

      const heapLimit = meter.createObservableGauge('v8js.memory.heap.limit', {
        unit: 'By',
        description: 'V8 heap memory total available size.',
      })
      heapLimit.addCallback((result) => {
        const heapStats = v8.getHeapStatistics()
        result.observe(heapStats.heap_size_limit)
      })

      const heapSpaceAvailable = meter.createObservableGauge('v8js.memory.heap.space.available_size', {
        unit: 'By',
        description: 'V8 heap space available size.',
      })
      heapSpaceAvailable.addCallback((result) => {
        for (const space of v8.getHeapSpaceStatistics()) {
          result.observe(space.space_available_size, { 'v8js.heap.space.name': space.space_name })
        }
      })

      const heapSpacePhysical = meter.createObservableGauge('v8js.memory.heap.space.physical_size', {
        unit: 'By',
        description: 'V8 heap space physical size.',
      })
      heapSpacePhysical.addCallback((result) => {
        for (const space of v8.getHeapSpaceStatistics()) {
          result.observe(space.physical_space_size, { 'v8js.heap.space.name': space.space_name })
        }
      })

      // --- Process Metrics ---
      const memoryUsage = meter.createObservableGauge('process.memory.usage', {
        unit: 'By',
        description: 'Process resident set size (RSS).',
      })
      memoryUsage.addCallback((result) => {
        result.observe(process.memoryUsage().rss)
      })

      const cpuUtilization = meter.createObservableGauge('process.cpu.utilization', {
        unit: '1',
        description:
          'Difference in process.cpu.time since the last measurement, ' +
          'divided by the elapsed time and number of CPUs available to the process.',
      })
      cpuUtilization.addCallback((result) => {
        const now = performance.now()
        const elapsed = (now - lastTime) / 1000
        const cpuUsage = process.cpuUsage()
        const numCpus = os.cpus().length

        if (elapsed > 0 && lastCpuUsage) {
          const userDelta = (cpuUsage.user - lastCpuUsage.user) / 1e6
          const systemDelta = (cpuUsage.system - lastCpuUsage.system) / 1e6
          result.observe(userDelta / (elapsed * numCpus), { 'process.cpu.state': 'user' })
          result.observe(systemDelta / (elapsed * numCpus), { 'process.cpu.state': 'system' })
        }

        lastCpuUsage = cpuUsage
        lastTime = now
      })

      // --- Event Loop Metrics ---
      if (trackEventLoop) {
        const eventLoopDelayMin = meter.createObservableGauge('nodejs.eventloop.delay.min', {
          unit: 'ns',
          description: 'Event loop minimum delay.',
        })
        eventLoopDelayMin.addCallback((result) => {
          if (eventLoopHistogram) result.observe(eventLoopHistogram.min * 1e6)
        })

        const eventLoopDelayMax = meter.createObservableGauge('nodejs.eventloop.delay.max', {
          unit: 'ns',
          description: 'Event loop maximum delay.',
        })
        eventLoopDelayMax.addCallback((result) => {
          if (eventLoopHistogram) result.observe(eventLoopHistogram.max * 1e6)
        })

        const eventLoopDelayMean = meter.createObservableGauge('nodejs.eventloop.delay.mean', {
          unit: 'ns',
          description: 'Event loop mean delay.',
        })
        eventLoopDelayMean.addCallback((result) => {
          if (eventLoopHistogram) result.observe(eventLoopHistogram.mean * 1e6)
        })

        const eventLoopDelayP50 = meter.createObservableGauge('nodejs.eventloop.delay.p50', {
          unit: 'ns',
          description: 'Event loop 50th percentile delay.',
        })
        eventLoopDelayP50.addCallback((result) => {
          if (eventLoopHistogram) result.observe(eventLoopHistogram.percentile(50) * 1e6)
        })

        const eventLoopDelayP90 = meter.createObservableGauge('nodejs.eventloop.delay.p90', {
          unit: 'ns',
          description: 'Event loop 90th percentile delay.',
        })
        eventLoopDelayP90.addCallback((result) => {
          if (eventLoopHistogram) result.observe(eventLoopHistogram.percentile(90) * 1e6)
        })

        const eventLoopDelayP99 = meter.createObservableGauge('nodejs.eventloop.delay.p99', {
          unit: 'ns',
          description: 'Event loop 99th percentile delay.',
        })
        eventLoopDelayP99.addCallback((result) => {
          if (eventLoopHistogram) result.observe(eventLoopHistogram.percentile(99) * 1e6)
        })

        if (performance.eventLoopUtilization) {
          const eventLoopUtilization = meter.createObservableGauge('nodejs.eventloop.utilization', {
            unit: '1',
            description: 'Event loop utilization ratio.',
          })
          eventLoopUtilization.addCallback((result) => {
            const elu = performance.eventLoopUtilization()
            result.observe(elu.utilization)
          })
        }
      }

      log.debug('Started OTLP runtime metrics with OTel-native naming (v8js.*, nodejs.*, process.*)')
    } catch (err) {
      log.error('Failed to start OTLP runtime metrics:', err)
    }
  },

  stop () {
    if (eventLoopHistogram) {
      eventLoopHistogram.disable()
      eventLoopHistogram = null
    }
    meter = null
    lastCpuUsage = null
    lastTime = 0
  },

  // Noop methods expected by the rest of the tracer (e.g. agent writer)
  // when this module replaces the DogStatsD runtime_metrics module.
  track () {},
  boolean () {},
  histogram () {},
  count () {},
  gauge () {},
  increment () {},
  decrement () {},
}
