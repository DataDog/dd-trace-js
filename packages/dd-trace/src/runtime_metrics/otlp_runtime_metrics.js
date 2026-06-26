'use strict'

const v8 = require('node:v8')
const process = require('node:process')
const { performance, monitorEventLoopDelay, PerformanceObserver, constants } = require('node:perf_hooks')
const { metrics } = require('../opentelemetry/api').load()
const log = require('../log')
const { createMetricsClient } = require('./client')

const METER_NAME = 'datadog.runtime_metrics'

const ATTR_ELU_STATE_IDLE = { 'nodejs.eventloop.state': 'idle' }
const ATTR_ELU_STATE_ACTIVE = { 'nodejs.eventloop.state': 'active' }

// Pre-allocated `{ 'v8js.gc.type': <type> }` attribute objects so the observer
// doesn't allocate a new one per entry under GC pressure.
const ATTR_GC_TYPE_MINOR = { 'v8js.gc.type': 'minor' }
const ATTR_GC_TYPE_MAJOR = { 'v8js.gc.type': 'major' }
const ATTR_GC_TYPE_INCREMENTAL = { 'v8js.gc.type': 'incremental' }
const ATTR_GC_TYPE_WEAKCB = { 'v8js.gc.type': 'weakcb' }

// Kind 2 is V8's MinorMarkSweep (Node 20+) and not exposed via perf_hooks.constants.
const GC_ATTR_BY_KIND = new Map([
  [constants.NODE_PERFORMANCE_GC_MINOR, ATTR_GC_TYPE_MINOR],
  [2, ATTR_GC_TYPE_MINOR],
  [constants.NODE_PERFORMANCE_GC_MAJOR, ATTR_GC_TYPE_MAJOR],
  [constants.NODE_PERFORMANCE_GC_INCREMENTAL, ATTR_GC_TYPE_INCREMENTAL],
  [constants.NODE_PERFORMANCE_GC_WEAKCB, ATTR_GC_TYPE_WEAKCB],
])

let meter = null
let eventLoopHistogram = null
let gcObserver = null
let lastElu = null

// Cache `{ 'v8js.heap.space.name': <name> }` per V8 space name to avoid per-scrape allocations.
const HEAP_SPACE_ATTR_CACHE = new Map()
function getHeapSpaceAttr (name) {
  let attr = HEAP_SPACE_ATTR_CACHE.get(name)
  if (!attr) {
    attr = { 'v8js.heap.space.name': name }
    HEAP_SPACE_ATTR_CACHE.set(name, attr)
  }
  return attr
}

// getMeter() returns a cached meter, so without tracking what we registered we'd
// stack callbacks every time start() runs.
const registeredCallbacks = []
const registeredBatchCallbacks = []

// DD-proprietary tracer metrics (runtime.node.spans.*, datadog.tracer.*) have no OTel
// equivalent; keep a DogStatsD client so OTLP-path customers don't lose them.
let client = null
let flushInterval = null

module.exports = {
  /**
   * @param {import('../config/config-base')} config - Tracer configuration
   */
  start (config) {
    this.stop()

    client = createMetricsClient(config)
    flushInterval = setInterval(() => {
      client.flush()
    }, config.DD_RUNTIME_METRICS_FLUSH_INTERVAL ?? 10_000)
    flushInterval.unref?.()

    meter = metrics.getMeterProvider().getMeter(METER_NAME)

    const trackEventLoop = config.runtimeMetrics.eventLoop !== false
    const trackGc = config.runtimeMetrics.gc !== false
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
      (result) => {
        const stats = v8.getHeapStatistics()
        result.observe(heapLimit, stats.heap_size_limit)

        const spaces = v8.getHeapSpaceStatistics()
        for (let i = 0; i < spaces.length; i++) {
          const space = spaces[i]
          const attr = getHeapSpaceAttr(space.space_name)
          result.observe(heapUsed, space.space_used_size, attr)
          result.observe(heapSpaceAvailable, space.space_available_size, attr)
          result.observe(heapSpacePhysical, space.physical_space_size, attr)
          result.observe(heapSpaceSize, space.space_size, attr)
        }
      },
      [heapUsed, heapLimit, heapSpaceAvailable, heapSpacePhysical, heapSpaceSize]
    )

    const activeResource = meter.createObservableGauge('v8js.resource.active', {
      unit: '{resource}',
      description: 'Gauge of the active resources that are currently keeping the event loop alive.',
    })
    registerCallback((result) => {
      const counts = new Map()
      // Stable since Node 22.16; available on 18+ as experimental.
      // eslint-disable-next-line n/no-unsupported-features/node-builtins
      for (const resource of process.getActiveResourcesInfo()) {
        counts.set(resource, (counts.get(resource) ?? 0) + 1)
      }
      for (const [type, count] of counts) {
        result.observe(count, { 'v8js.resource.type': type })
      }
    }, activeResource)

    // Spec wants nodejs.eventloop.delay.* in seconds; perf_hooks gives nanoseconds.
    // Match @opentelemetry/instrumentation-runtime-node EventLoopDelayCollector: one batch
    // callback, guard on sample count, emit, then reset so each interval is independent.
    if (trackEventLoop) {
      const delayMin = createDelayGauge('nodejs.eventloop.delay.min', 'Event loop minimum delay.')
      const delayMax = createDelayGauge('nodejs.eventloop.delay.max', 'Event loop maximum delay.')
      const delayMean = createDelayGauge('nodejs.eventloop.delay.mean', 'Event loop mean delay.')
      const delayStddev = createDelayGauge('nodejs.eventloop.delay.stddev', 'Event loop standard deviation delay.')
      const delayP50 = createDelayGauge('nodejs.eventloop.delay.p50', 'Event loop 50th percentile delay.')
      const delayP90 = createDelayGauge('nodejs.eventloop.delay.p90', 'Event loop 90th percentile delay.')
      const delayP99 = createDelayGauge('nodejs.eventloop.delay.p99', 'Event loop 99th percentile delay.')

      registerBatchCallback((result) => {
        const h = eventLoopHistogram
        if (!h || h.count < 5) return
        result.observe(delayMin, h.min / 1e9)
        result.observe(delayMax, h.max / 1e9)
        result.observe(delayMean, h.mean / 1e9)
        result.observe(delayStddev, h.stddev / 1e9)
        result.observe(delayP50, h.percentile(50) / 1e9)
        result.observe(delayP90, h.percentile(90) / 1e9)
        result.observe(delayP99, h.percentile(99) / 1e9)
        h.reset()
      }, [delayMin, delayMax, delayMean, delayStddev, delayP50, delayP90, delayP99])

      if (performance.eventLoopUtilization) {
        // Baseline so the first observation isn't 1.0.
        lastElu = performance.eventLoopUtilization()

        const eluTime = meter.createObservableCounter('nodejs.eventloop.time', {
          unit: 's',
          description: 'Cumulative duration of time the event loop has been in each state.',
        })
        registerCallback((result) => {
          const elu = performance.eventLoopUtilization()
          result.observe(elu.idle / 1000, ATTR_ELU_STATE_IDLE)
          result.observe(elu.active / 1000, ATTR_ELU_STATE_ACTIVE)
        }, eluTime)

        const eluGauge = meter.createObservableGauge('nodejs.eventloop.utilization', {
          unit: '1',
          description: 'Event loop utilization.',
        })
        registerCallback((result) => {
          const current = performance.eventLoopUtilization()
          const idle = current.idle - lastElu.idle
          const active = current.active - lastElu.active
          lastElu = current
          const total = idle + active
          result.observe(total > 0 ? active / total : 0)
        }, eluGauge)
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
          const attr = GC_ATTR_BY_KIND.get(entry.detail?.kind ?? entry.kind)
          if (attr === undefined) continue
          gcHistogram.record(entry.duration / 1000, attr)
        }
      })
      gcObserver.observe({ type: 'gc' })
    }

    log.debug('Started OTLP runtime metrics with OTel-native naming (v8js.*, nodejs.*)')
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
      const [callback, instrument] = registeredCallbacks[i]
      instrument.removeCallback(callback)
    }
    registeredCallbacks.length = 0
    if (meter) {
      for (let i = 0; i < registeredBatchCallbacks.length; i++) {
        const [callback, instruments] = registeredBatchCallbacks[i]
        meter.removeBatchObservableCallback(callback, instruments)
      }
    }
    registeredBatchCallbacks.length = 0
    meter = null
    lastElu = null
    if (flushInterval) {
      clearInterval(flushInterval)
      flushInterval = null
    }
    client = null
  },

  // Tied to @datadog/native-metrics which the OTLP path doesn't enable; noop with expected shape.
  track () { return { finish () {} } },

  boolean (name, value, tag) {
    client?.boolean(name, value, tag)
  },
  histogram (name, value, tag) {
    client?.histogram(name, value, tag)
  },
  count (name, count, tag, monotonic = false) {
    client?.count(name, count, tag, monotonic)
  },
  gauge (name, value, tag) {
    client?.gauge(name, value, tag)
  },
  increment (name, tag, monotonic) {
    this.count(name, 1, tag, monotonic)
  },
  decrement (name, tag) {
    this.count(name, -1, tag)
  },
}

/**
 * @param {Function} callback
 * @param {object} instrument
 */
function registerCallback (callback, instrument) {
  instrument.addCallback(callback)
  registeredCallbacks.push([callback, instrument])
}

/**
 * @param {Function} callback
 * @param {Array} instruments
 */
function registerBatchCallback (callback, instruments) {
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
 * @returns {object}
 */
function createDelayGauge (name, description) {
  return meter.createObservableGauge(name, { unit: 's', description })
}
