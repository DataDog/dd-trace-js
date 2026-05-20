'use strict'

const v8 = require('node:v8')
const process = require('node:process')
const { performance, monitorEventLoopDelay, PerformanceObserver, constants } = require('node:perf_hooks')
const log = require('../log')

const METER_NAME = 'datadog.runtime_metrics'

const ATTR_ELU_STATE_IDLE = { 'nodejs.eventloop.state': 'idle' }
const ATTR_ELU_STATE_ACTIVE = { 'nodejs.eventloop.state': 'active' }

// Kind 2 is V8's MinorMarkSweep (Node 20+) and not exposed via perf_hooks.constants.
const GC_TYPE_BY_KIND = new Map([
  [constants.NODE_PERFORMANCE_GC_MINOR, 'minor'],
  [2, 'minor'],
  [constants.NODE_PERFORMANCE_GC_MAJOR, 'major'],
  [constants.NODE_PERFORMANCE_GC_INCREMENTAL, 'incremental'],
  [constants.NODE_PERFORMANCE_GC_WEAKCB, 'weakcb'],
])

let meter = null
let eventLoopHistogram = null
let gcObserver = null
let lastElu = null

// getMeter() returns a cached meter, so without tracking what we registered we'd
// stack callbacks every time start() runs.
const registeredCallbacks = []
const registeredBatchCallbacks = []

module.exports = {
  /**
   * @param {import('../config/config-base')} config - Tracer configuration
   */
  start (config) {
    this.stop()

    try {
      const { metrics } = require('@opentelemetry/api')
      meter = metrics.getMeterProvider().getMeter(METER_NAME)

      const trackEventLoop = config.runtimeMetrics?.eventLoop !== false
      const trackGc = config.runtimeMetrics?.gc !== false
      if (trackEventLoop) {
        eventLoopHistogram = monitorEventLoopDelay({ resolution: 4 })
        eventLoopHistogram.enable()
      }

      const heapUsed = createHeapInstrument('v8js.memory.heap.used', 'V8 heap memory used.')
      const heapLimit = createHeapInstrument('v8js.memory.heap.limit', 'V8 heap memory total available size.')
      const heapSpaceAvailable = createHeapInstrument(
        'v8js.memory.heap.space.available_size', 'V8 heap space available size.')
      const heapSpacePhysical = createHeapInstrument(
        'v8js.memory.heap.space.physical_size', 'V8 heap space physical size.')
      const heapSpaceSize = createHeapInstrument(
        'v8js.memory.heap.space.size', 'Total heap memory size pre-allocated for a heap space.')

      registerBatchCallback(
        [heapUsed, heapLimit, heapSpaceAvailable, heapSpacePhysical, heapSpaceSize],
        (result) => {
          const stats = v8.getHeapStatistics()
          result.observe(heapLimit, stats.heap_size_limit)

          const spaces = v8.getHeapSpaceStatistics()
          for (let i = 0; i < spaces.length; i++) {
            const space = spaces[i]
            const attr = { 'v8js.heap.space.name': space.space_name }
            result.observe(heapUsed, space.space_used_size, attr)
            result.observe(heapSpaceAvailable, space.space_available_size, attr)
            result.observe(heapSpacePhysical, space.physical_space_size, attr)
            result.observe(heapSpaceSize, space.space_size, attr)
          }
        }
      )

      const activeResource = meter.createObservableGauge('v8js.resource.active', {
        unit: '{resource}',
        description: 'Gauge of the active resources that are currently keeping the event loop alive.',
      })
      registerCallback(activeResource, (result) => {
        const counts = new Map()
        // Stable since Node 22.16; available on 18+ as experimental.
        // eslint-disable-next-line n/no-unsupported-features/node-builtins
        for (const resource of process.getActiveResourcesInfo()) {
          counts.set(resource, (counts.get(resource) ?? 0) + 1)
        }
        for (const [type, count] of counts) {
          result.observe(count, { 'v8js.resource.type': type })
        }
      })

      // Spec wants nodejs.eventloop.delay.* in seconds; perf_hooks gives nanoseconds.
      if (trackEventLoop) {
        defineEventLoopDelay('nodejs.eventloop.delay.min', 'Event loop minimum delay.', h => h.min)
        defineEventLoopDelay('nodejs.eventloop.delay.max', 'Event loop maximum delay.', h => h.max)
        defineEventLoopDelay('nodejs.eventloop.delay.mean', 'Event loop mean delay.', h => h.mean)
        defineEventLoopDelay('nodejs.eventloop.delay.stddev', 'Event loop standard deviation delay.', h => h.stddev)
        defineEventLoopDelay('nodejs.eventloop.delay.p50', 'Event loop 50th percentile delay.', h => h.percentile(50))
        defineEventLoopDelay('nodejs.eventloop.delay.p90', 'Event loop 90th percentile delay.', h => h.percentile(90))
        defineEventLoopDelay('nodejs.eventloop.delay.p99', 'Event loop 99th percentile delay.', h => h.percentile(99))

        if (performance.eventLoopUtilization) {
          // Baseline so the first observation isn't 1.0.
          lastElu = performance.eventLoopUtilization()

          const eluTime = meter.createObservableCounter('nodejs.eventloop.time', {
            unit: 's',
            description: 'Cumulative duration of time the event loop has been in each state.',
          })
          registerCallback(eluTime, (result) => {
            const elu = performance.eventLoopUtilization()
            result.observe(elu.idle / 1000, ATTR_ELU_STATE_IDLE)
            result.observe(elu.active / 1000, ATTR_ELU_STATE_ACTIVE)
          })

          const eluGauge = meter.createObservableGauge('nodejs.eventloop.utilization', {
            unit: '1',
            description: 'Event loop utilization.',
          })
          registerCallback(eluGauge, (result) => {
            const current = performance.eventLoopUtilization()
            const idle = current.idle - lastElu.idle
            const active = current.active - lastElu.active
            lastElu = current
            const total = idle + active
            if (total > 0) result.observe(active / total)
          })
        }
      }

      if (trackGc) {
        const gcHistogram = meter.createHistogram('v8js.gc.duration', {
          unit: 's',
          description: 'Garbage collection duration.',
        })
        gcObserver = new PerformanceObserver(list => {
          const entries = list.getEntries()
          for (let i = 0; i < entries.length; i++) {
            const entry = entries[i]
            const type = GC_TYPE_BY_KIND.get(entry.detail?.kind ?? entry.kind)
            if (type === undefined) continue
            gcHistogram.record(entry.duration / 1000, { 'v8js.gc.type': type })
          }
        })
        gcObserver.observe({ type: 'gc' })
      }

      log.debug('Started OTLP runtime metrics with OTel-native naming (v8js.*, nodejs.*)')
    } catch (err) {
      // Unwind whatever managed to register so a partial init doesn't leak into the next start().
      this.stop()
      log.error('Failed to start OTLP runtime metrics', err)
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
    gcObserver?.disconnect()
    gcObserver = null
    for (let i = 0; i < registeredCallbacks.length; i++) {
      const [instrument, callback] = registeredCallbacks[i]
      instrument.removeCallback?.(callback)
    }
    registeredCallbacks.length = 0
    if (meter) {
      for (let i = 0; i < registeredBatchCallbacks.length; i++) {
        const [callback, instruments] = registeredBatchCallbacks[i]
        meter.removeBatchObservableCallback?.(callback, instruments)
      }
    }
    registeredBatchCallbacks.length = 0
    meter = null
    lastElu = null
  },

  // Called from opentracing/span.js and tracer.js with DD-proprietary names; no OTel equivalent.
  increment () {},
  decrement () {},
}

/**
 * @param {object} instrument
 * @param {Function} callback
 */
function registerCallback (instrument, callback) {
  instrument.addCallback(callback)
  registeredCallbacks.push([instrument, callback])
}

/**
 * @param {Array} instruments
 * @param {Function} callback
 */
function registerBatchCallback (instruments, callback) {
  meter.addBatchObservableCallback(callback, instruments)
  registeredBatchCallbacks.push([callback, instruments])
}

/**
 * @param {string} name
 * @param {string} description
 * @returns {object}
 */
function createHeapInstrument (name, description) {
  return meter.createObservableUpDownCounter(name, { unit: 'By', description })
}

/**
 * @param {string} name
 * @param {string} description
 * @param {(histogram: import('node:perf_hooks').IntervalHistogram) => number} getValue
 */
function defineEventLoopDelay (name, description, getValue) {
  const m = meter.createObservableGauge(name, { unit: 's', description })
  registerCallback(m, (result) => {
    if (eventLoopHistogram) result.observe(getValue(eventLoopHistogram) / 1e9)
  })
}
