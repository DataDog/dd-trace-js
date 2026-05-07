'use strict'

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
let lastElu = null

module.exports = {
  /**
   * @param {import('../config/config-base')} config - Tracer configuration
   */
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

      lastCpuUsage = process.cpuUsage()
      lastTime = performance.now()

      const trackEventLoop = config.runtimeMetrics?.eventLoop !== false
      if (trackEventLoop && monitorEventLoopDelay) {
        eventLoopHistogram = monitorEventLoopDelay({ resolution: 4 })
        eventLoopHistogram.enable()
      }

      defineHeapStat('v8js.memory.heap.used', 'V8 heap memory used.', s => s.used_heap_size)
      defineHeapStat('v8js.memory.heap.limit', 'V8 heap memory total available size.', s => s.heap_size_limit)
      defineHeapSpaceStat('v8js.memory.heap.space.available_size', 'V8 heap space available size.',
        s => s.space_available_size)
      defineHeapSpaceStat('v8js.memory.heap.space.physical_size', 'V8 heap space physical size.',
        s => s.physical_space_size)

      const memoryUsage = meter.createObservableUpDownCounter('process.memory.usage', {
        unit: 'By',
        description: 'Process resident set size (RSS).',
      })
      memoryUsage.addCallback((result) => result.observe(process.memoryUsage().rss))

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

      // OTel semconv reports nodejs.eventloop.delay.* in seconds; perf_hooks gives nanoseconds.
      if (trackEventLoop) {
        defineEventLoopDelay('nodejs.eventloop.delay.min', 'Event loop minimum delay.', h => h.min)
        defineEventLoopDelay('nodejs.eventloop.delay.max', 'Event loop maximum delay.', h => h.max)
        defineEventLoopDelay('nodejs.eventloop.delay.mean', 'Event loop mean delay.', h => h.mean)
        defineEventLoopDelay('nodejs.eventloop.delay.stddev', 'Event loop standard deviation delay.', h => h.stddev)
        defineEventLoopDelay('nodejs.eventloop.delay.p50', 'Event loop 50th percentile delay.', h => h.percentile(50))
        defineEventLoopDelay('nodejs.eventloop.delay.p90', 'Event loop 90th percentile delay.', h => h.percentile(90))
        defineEventLoopDelay('nodejs.eventloop.delay.p99', 'Event loop 99th percentile delay.', h => h.percentile(99))

        if (performance.eventLoopUtilization) {
          // Capture baseline so the first observation isn't 1.
          lastElu = performance.eventLoopUtilization()
          const eluGauge = meter.createObservableGauge('nodejs.eventloop.utilization', {
            unit: '1',
            description: 'Event loop utilization.',
          })
          eluGauge.addCallback((result) => {
            const current = performance.eventLoopUtilization()
            const delta = performance.eventLoopUtilization(current, lastElu)
            lastElu = current
            result.observe(delta.utilization)
          })
        }
      }

      log.debug('Started OTLP runtime metrics with OTel-native naming (v8js.*, nodejs.*, process.*)')
    } catch (err) {
      log.error('Failed to start OTLP runtime metrics:', err)
    }
  },

  /**
   * @returns {void}
   */
  stop () {
    if (eventLoopHistogram) {
      eventLoopHistogram.disable()
      eventLoopHistogram = null
    }
    meter = null
    lastCpuUsage = null
    lastTime = 0
    lastElu = null
  },

  // Noop methods expected by the rest of the tracer when this module
  // replaces the DogStatsD runtime_metrics module.
  track () {},
  boolean () {},
  histogram () {},
  count () {},
  gauge () {},
  increment () {},
  decrement () {},
}

function defineHeapStat (name, description, getValue) {
  const m = meter.createObservableUpDownCounter(name, { unit: 'By', description })
  m.addCallback((result) => result.observe(getValue(v8.getHeapStatistics())))
}

function defineHeapSpaceStat (name, description, getValue) {
  const m = meter.createObservableUpDownCounter(name, { unit: 'By', description })
  m.addCallback((result) => {
    for (const space of v8.getHeapSpaceStatistics()) {
      result.observe(getValue(space), { 'v8js.heap.space.name': space.space_name })
    }
  })
}

function defineEventLoopDelay (name, description, getValue) {
  const m = meter.createObservableGauge(name, { unit: 's', description })
  m.addCallback((result) => {
    if (eventLoopHistogram) result.observe(getValue(eventLoopHistogram) / 1e9)
  })
}
