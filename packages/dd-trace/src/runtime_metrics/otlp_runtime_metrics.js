'use strict'

// OTLP runtime metrics with OTel-native naming for Node.js
//
// OTel Node.js runtime metrics conventions:
// - v8js.memory.heap.* (V8 heap metrics)
// - nodejs.eventloop.delay.* (event loop delay)
// - process.cpu.utilization (CPU usage)
// - process.memory.usage (RSS memory)
//
// Semantic-core equivalence mappings:
// https://github.com/DataDog/semantic-core/blob/main/sor/domains/metrics/
// integrations/nodejs/_equivalence/otel_dd.yaml

const v8 = require('node:v8')
const process = require('node:process')
const os = require('node:os')
const { performance, monitorEventLoopDelay } = require('node:perf_hooks')
const log = require('../log')

const METER_NAME = 'datadog.runtime_metrics'

let meter = null
let observableRegistration = null
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
      // v8js.memory.heap.used - V8 heap used
      // Maps to: runtime.node.heap.used_size.by.space (via semantic-core)
      const heapUsed = meter.createObservableGauge('v8js.memory.heap.used', {
        unit: 'By',
        description: 'V8 heap memory used.',
      })

      // v8js.memory.heap.limit - V8 heap size limit
      // Maps to: runtime.node.heap.size.by.space
      const heapLimit = meter.createObservableGauge('v8js.memory.heap.limit', {
        unit: 'By',
        description: 'V8 heap memory total available size.',
      })

      // v8js.memory.heap.space.available_size - Available size per heap space
      // Maps to: runtime.node.heap.available_size.by.space
      const heapSpaceAvailable = meter.createObservableGauge('v8js.memory.heap.space.available_size', {
        unit: 'By',
        description: 'V8 heap space available size.',
      })

      // v8js.memory.heap.space.physical_size - Physical size per heap space
      // Maps to: runtime.node.heap.physical_size.by.space
      const heapSpacePhysical = meter.createObservableGauge('v8js.memory.heap.space.physical_size', {
        unit: 'By',
        description: 'V8 heap space physical size.',
      })

      // --- Process Metrics ---
      // process.memory.usage - RSS memory
      // Maps to: runtime.node.mem.rss
      const memoryUsage = meter.createObservableGauge('process.memory.usage', {
        unit: 'By',
        description: 'Process resident set size (RSS).',
      })

      // process.cpu.utilization - CPU utilization
      // Maps to: runtime.node.cpu.user / runtime.node.cpu.system
      // Attributes: process.cpu.state = {user, system}
      const cpuUtilization = meter.createObservableGauge('process.cpu.utilization', {
        unit: '1',
        description:
          'Difference in process.cpu.time since the last measurement, ' +
          'divided by the elapsed time and number of CPUs available to the process.',
      })

      // --- Event Loop Metrics ---
      const eventLoopDelayMin = trackEventLoop
        ? meter.createObservableGauge('nodejs.eventloop.delay.min', {
          unit: 'ns',
          description: 'Event loop minimum delay.',
        })
        : null

      const eventLoopDelayMax = trackEventLoop
        ? meter.createObservableGauge('nodejs.eventloop.delay.max', {
          unit: 'ns',
          description: 'Event loop maximum delay.',
        })
        : null

      const eventLoopDelayMean = trackEventLoop
        ? meter.createObservableGauge('nodejs.eventloop.delay.mean', {
          unit: 'ns',
          description: 'Event loop mean delay.',
        })
        : null

      const eventLoopDelayP50 = trackEventLoop
        ? meter.createObservableGauge('nodejs.eventloop.delay.p50', {
          unit: 'ns',
          description: 'Event loop 50th percentile delay.',
        })
        : null

      // Register batch callback for all observable instruments
      const observables = [
        heapUsed, heapLimit, heapSpaceAvailable, heapSpacePhysical,
        memoryUsage, cpuUtilization,
      ]
      if (trackEventLoop) {
        observables.push(eventLoopDelayMin, eventLoopDelayMax, eventLoopDelayMean, eventLoopDelayP50)
      }

      observableRegistration = meter.addBatchObservableCallback((observer) => {
        // V8 heap statistics
        const heapStats = v8.getHeapStatistics()
        observer.observe(heapUsed, heapStats.used_heap_size)
        observer.observe(heapLimit, heapStats.heap_size_limit)

        // V8 heap space statistics (with v8js.heap.space.name attribute)
        const heapSpaces = v8.getHeapSpaceStatistics()
        for (const space of heapSpaces) {
          const attrs = { 'v8js.heap.space.name': space.space_name }
          observer.observe(heapSpaceAvailable, space.space_available_size, attrs)
          observer.observe(heapSpacePhysical, space.physical_space_size, attrs)
        }

        // Process memory (RSS)
        const mem = process.memoryUsage()
        observer.observe(memoryUsage, mem.rss)

        // CPU utilization
        const now = performance.now()
        const elapsed = (now - lastTime) / 1000 // seconds
        const cpuUsage = process.cpuUsage()
        const numCpus = os.cpus().length

        if (elapsed > 0 && lastCpuUsage) {
          const userDelta = (cpuUsage.user - lastCpuUsage.user) / 1e6 // microseconds to seconds
          const systemDelta = (cpuUsage.system - lastCpuUsage.system) / 1e6
          observer.observe(cpuUtilization, userDelta / (elapsed * numCpus), { 'process.cpu.state': 'user' })
          observer.observe(cpuUtilization, systemDelta / (elapsed * numCpus), { 'process.cpu.state': 'system' })
        }

        lastCpuUsage = cpuUsage
        lastTime = now

        // Event loop delay
        if (trackEventLoop && eventLoopHistogram) {
          observer.observe(eventLoopDelayMin, eventLoopHistogram.min * 1e6) // ms to ns
          observer.observe(eventLoopDelayMax, eventLoopHistogram.max * 1e6)
          observer.observe(eventLoopDelayMean, eventLoopHistogram.mean * 1e6)
          observer.observe(eventLoopDelayP50, eventLoopHistogram.percentile(50) * 1e6)
          eventLoopHistogram.reset()
        }
      }, observables)

      log.debug('Started OTLP runtime metrics with OTel-native naming (v8js.*, nodejs.*, process.*)')
    } catch (err) {
      log.error('Failed to start OTLP runtime metrics:', err)
    }
  },

  stop () {
    if (observableRegistration) {
      observableRegistration = null
    }
    if (eventLoopHistogram) {
      eventLoopHistogram.disable()
      eventLoopHistogram = null
    }
    meter = null
    lastCpuUsage = null
    lastTime = 0
  },
}
