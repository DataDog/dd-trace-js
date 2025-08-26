'use strict'

// TODO: capture every second and flush every 10 seconds

const v8 = require('v8')
const os = require('os')
const process = require('process')
const { DogStatsDClient, MetricsAggregationClient } = require('../dogstatsd')
const log = require('../log')
const { performance, PerformanceObserver } = require('perf_hooks')
const { getEnvironmentVariable } = require('../config-helper')

const { NODE_MAJOR } = require('../../../../version')
// TODO: This environment variable may not be changed, since the agent expects a flush every ten seconds.
// It is only a variable for testing. Think about alternatives.
const DD_RUNTIME_METRICS_FLUSH_INTERVAL = getEnvironmentVariable('DD_RUNTIME_METRICS_FLUSH_INTERVAL') ?? '10000'
const INTERVAL = Number.parseInt(DD_RUNTIME_METRICS_FLUSH_INTERVAL, 10)

let startTime = 0n
let nativeMetrics = null
let gcObserver = null
let interval = null
let client = null
let lastTime = 0n
let lastCpuUsage = null

// !!!!!!!!!!!
//  IMPORTANT
// !!!!!!!!!!!
//
// ALL metrics that relate to time are handled in nanoseconds in the backend.
// https://github.com/DataDog/dogweb/blob/prod/integration/node/node_metadata.csv

module.exports = {
  start (config) {
    this.stop()
    const clientConfig = DogStatsDClient.generateClientConfig(config)
    const watchers = []

    const trackEventLoop = config.runtimeMetrics.eventLoop !== false
    const trackGc = config.runtimeMetrics.gc !== false

    if (trackGc) {
      startGCObserver()
    }

    if (trackEventLoop) {
      watchers.push('loop')
    }

    try {
      nativeMetrics = require('@datadog/native-metrics')
      nativeMetrics.start(...watchers)
    } catch (error) {
      log.error('Error starting native metrics', error)
      nativeMetrics = null
    }

    client = new MetricsAggregationClient(new DogStatsDClient(clientConfig))

    lastTime = process.hrtime.bigint()

    if (nativeMetrics) {
      interval = setInterval(() => {
        captureNativeMetrics(trackEventLoop, trackGc)
        captureCommonMetrics(trackEventLoop)
        client.flush()
      }, INTERVAL)
    } else {
      lastCpuUsage = process.cpuUsage()

      interval = setInterval(() => {
        captureCpuUsage()
        captureCommonMetrics(trackEventLoop)
        captureHeapSpace()
        client.flush()
      }, INTERVAL)
    }

    interval.unref()
    // The starttime plus half a second for rounding.
    startTime = lastTime - BigInt(Math.round(process.uptime() * 1e9)) + 500_000_000n
  },

  stop () {
    nativeMetrics?.stop()
    nativeMetrics = null

    clearInterval(interval)
    interval = null

    client = null
    lastTime = 0n
    lastCpuUsage = null

    gcObserver?.disconnect()
    gcObserver = null
  },

  track (span) {
    if (nativeMetrics) {
      const handle = nativeMetrics.track(span)

      return {
        finish: () => nativeMetrics.finish(handle)
      }
    }

    return { finish: () => {} }
  },

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
  }
}

function captureCpuUsage () {
  const currentTime = process.hrtime.bigint() // Nanoseconds
  const elapsedTime = currentTime - lastTime
  lastTime = currentTime

  const currentCpuUsage = process.cpuUsage()

  const elapsedUsageUser = currentCpuUsage.user - lastCpuUsage.user
  const elapsedUsageSystem = currentCpuUsage.system - lastCpuUsage.system

  const elapsedUsMultipliedBy100 = Number(elapsedTime / 100_000n) // Microseconds * 100 for percent
  const userPercent = elapsedUsageUser / elapsedUsMultipliedBy100
  const systemPercent = elapsedUsageSystem / elapsedUsMultipliedBy100
  const totalPercent = userPercent + systemPercent

  lastCpuUsage = currentCpuUsage

  client.gauge('runtime.node.cpu.system', systemPercent.toFixed(2))
  client.gauge('runtime.node.cpu.user', userPercent.toFixed(2))
  client.gauge('runtime.node.cpu.total', totalPercent.toFixed(2))
}

function captureMemoryUsage () {
  const stats = process.memoryUsage()

  client.gauge('runtime.node.mem.heap_total', stats.heapTotal)
  client.gauge('runtime.node.mem.heap_used', stats.heapUsed)
  client.gauge('runtime.node.mem.rss', stats.rss)
  client.gauge('runtime.node.mem.total', os.totalmem())
  client.gauge('runtime.node.mem.free', os.freemem())
  client.gauge('runtime.node.mem.external', stats.external)
  // TODO: Add arrayBuffers to the metrics. That also requires the
  // node_metadata.csv to be updated for the website.
  //
  // client.gauge('runtime.node.mem.arrayBuffers', stats.arrayBuffers)
}

function captureUptime () {
  // WARNING: lastTime must be updated in the same interval before this function is called!
  // This is a faster `process.uptime()`.
  client.gauge('runtime.node.process.uptime', Number((lastTime - startTime) / 1_000_000_000n))
}

function captureHeapStats () {
  const stats = v8.getHeapStatistics()

  client.gauge('runtime.node.heap.total_heap_size', stats.total_heap_size)
  client.gauge('runtime.node.heap.total_heap_size_executable', stats.total_heap_size_executable)
  client.gauge('runtime.node.heap.total_physical_size', stats.total_physical_size)
  client.gauge('runtime.node.heap.total_available_size', stats.total_available_size)
  client.gauge('runtime.node.heap.heap_size_limit', stats.heap_size_limit)
  client.gauge('runtime.node.heap.malloced_memory', stats.malloced_memory)
  client.gauge('runtime.node.heap.peak_malloced_memory', stats.peak_malloced_memory)
  // TODO: Add number_of_native_contexts and number_of_detached_contexts to the
  // metrics. Those metrics allow to identify memory leaks. Adding them also
  // requires the node_metadata.csv to be updated for the website.
  //
  // client.gauge('runtime.node.heap.number_of_native_contexts', stats.number_of_native_contexts)
  // client.gauge('runtime.node.heap.number_of_detached_contexts', stats.number_of_detached_contexts)
}

function captureHeapSpace () {
  const stats = v8.getHeapSpaceStatistics()

  for (let i = 0, l = stats.length; i < l; i++) {
    const tags = [`space:${stats[i].space_name}`]

    client.gauge('runtime.node.heap.size.by.space', stats[i].space_size, tags)
    client.gauge('runtime.node.heap.used_size.by.space', stats[i].space_used_size, tags)
    client.gauge('runtime.node.heap.available_size.by.space', stats[i].space_available_size, tags)
    client.gauge('runtime.node.heap.physical_size.by.space', stats[i].physical_space_size, tags)
  }
}

/**
 * Gathers and reports Event Loop Utilization (ELU) since last run, or from the
 * start of the process on first run.
 *
 * ELU is a measure of how busy the event loop is, like running JavaScript or
 * waiting on *Sync functions. The value is between 0 (idle) and 1 (exhausted).
 */
let lastElu = { idle: 0, active: 0 }
function captureELU () {
  const elu = performance.eventLoopUtilization()

  const idle = elu.idle - lastElu.idle
  const active = elu.active - lastElu.active
  const utilization = active / (idle + active)

  lastElu = elu

  client.gauge('runtime.node.event_loop.utilization', utilization)
}

function captureCommonMetrics (trackEventLoop) {
  captureMemoryUsage()
  captureUptime()
  captureHeapStats()
  if (trackEventLoop) {
    captureELU()
  }
}

function captureNativeMetrics (trackEventLoop, trackGc) {
  const stats = nativeMetrics.stats()
  const spaces = stats.heap.spaces

  const currentTime = process.hrtime.bigint() // Nanoseconds
  const elapsedUsTimeMultipliedBy100 = Number((currentTime - lastTime) / 100_000n)
  lastTime = currentTime

  const userPercent = stats.cpu.user / elapsedUsTimeMultipliedBy100
  const systemPercent = stats.cpu.system / elapsedUsTimeMultipliedBy100
  const totalPercent = userPercent + systemPercent

  client.gauge('runtime.node.cpu.system', systemPercent.toFixed(2))
  client.gauge('runtime.node.cpu.user', userPercent.toFixed(2))
  client.gauge('runtime.node.cpu.total', totalPercent.toFixed(2))

  if (trackEventLoop) {
    histogram('runtime.node.event_loop.delay', stats.eventLoop)
  }

  if (trackGc) {
    for (const [type, value] of Object.entries(stats.gc)) {
      if (type === 'all') {
        histogram('runtime.node.gc.pause', value)
      } else {
        histogram('runtime.node.gc.pause.by.type', value, `gc_type:${type}`)
      }
    }
  }

  for (let i = 0, l = spaces.length; i < l; i++) {
    const tag = `heap_space:${spaces[i].space_name}`

    client.gauge('runtime.node.heap.size.by.space', spaces[i].space_size, tag)
    client.gauge('runtime.node.heap.used_size.by.space', spaces[i].space_used_size, tag)
    client.gauge('runtime.node.heap.available_size.by.space', spaces[i].space_available_size, tag)
    client.gauge('runtime.node.heap.physical_size.by.space', spaces[i].physical_space_size, tag)
  }
}

function histogram (name, stats, tag) {
  client.gauge(`${name}.min`, stats.min, tag)
  client.gauge(`${name}.max`, stats.max, tag)
  client.increment(`${name}.sum`, stats.sum, tag)
  client.increment(`${name}.total`, stats.sum, tag)
  client.gauge(`${name}.avg`, stats.avg, tag)
  client.increment(`${name}.count`, stats.count, tag)
  client.gauge(`${name}.median`, stats.median, tag)
  client.gauge(`${name}.95percentile`, stats.p95, tag)
}

function startGCObserver () {
  if (gcObserver) return

  gcObserver = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) {
      const type = gcType(entry.detail?.kind || entry.kind)
      const duration = entry.duration * 1_000_000

      // These are individual metrics for each type of GC.
      client.histogram('runtime.node.gc.pause.by.type', duration, `gc_type:${type}`)
      client.histogram('runtime.node.gc.pause', duration)
    }
  })

  gcObserver.observe({ type: 'gc' })
}

const minorGCType = NODE_MAJOR >= 22 ? 'minor_mark_sweep' : 'minor_mark_compact'

function gcType (kind) {
  switch (kind) {
    case 1: return 'scavenge'
    case 2: return minorGCType
    case 4: return 'mark_sweep_compact' // Deprecated, might be removed soon.
    case 8: return 'incremental_marking'
    case 16: return 'process_weak_callbacks'
    case 31: return 'all'
    default: return 'unknown'
  }
}
