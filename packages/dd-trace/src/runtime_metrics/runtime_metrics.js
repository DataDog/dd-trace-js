'use strict'

// TODO: capture every second and flush every 10 seconds

const v8 = require('v8')
const os = require('os')
const { DogStatsDClient, MetricsAggregationClient } = require('../dogstatsd')
const log = require('../log')
const { performance, PerformanceObserver } = require('perf_hooks')
const { getEnvironmentVariable } = require('../config-helper')

const { NODE_MAJOR, NODE_MINOR } = require('../../../../version')
const DD_RUNTIME_METRICS_FLUSH_INTERVAL = getEnvironmentVariable('DD_RUNTIME_METRICS_FLUSH_INTERVAL') ?? '10000'
const INTERVAL = Number.parseInt(DD_RUNTIME_METRICS_FLUSH_INTERVAL, 10)

// Node >=16 has PerformanceObserver with `gc` type, but <16.7 had a critical bug.
// See: https://github.com/nodejs/node/issues/39548
const hasGCObserver = NODE_MAJOR >= 18 || (NODE_MAJOR === 16 && NODE_MINOR >= 7)

let nativeMetrics = null
let gcObserver = null

let interval
let client
let time
let cpuUsage
let elu

reset()

const runtimeMetrics = module.exports = {
  start (config) {
    const clientConfig = DogStatsDClient.generateClientConfig(config)
    const watchers = []

    if (config.runtimeMetrics.gc !== false) {
      if (hasGCObserver) {
        startGCObserver()
      } else {
        watchers.push('gc')
      }
    }

    if (config.runtimeMetrics.eventLoop !== false) {
      watchers.push('loop')
    }

    try {
      nativeMetrics = require('@datadog/native-metrics')
      nativeMetrics.start(...watchers)
    } catch (e) {
      log.error('Error starting native metrics', e)
      nativeMetrics = null
    }

    client = new MetricsAggregationClient(new DogStatsDClient(clientConfig))

    time = process.hrtime()

    if (nativeMetrics) {
      interval = setInterval(() => {
        captureCommonMetrics()
        captureNativeMetrics()
        client.flush()
      }, INTERVAL)
    } else {
      cpuUsage = process.cpuUsage()

      interval = setInterval(() => {
        captureCommonMetrics()
        captureCpuUsage()
        captureHeapSpace()
        client.flush()
      }, INTERVAL)
    }

    interval.unref()
  },

  stop () {
    if (nativeMetrics) {
      nativeMetrics.stop()
    }

    clearInterval(interval)
    reset()
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
    client && client.boolean(name, value, tag)
  },

  histogram (name, value, tag) {
    client && client.histogram(name, value, tag)
  },

  count (name, count, tag, monotonic = false) {
    client && client.count(name, count, tag, monotonic)
  },

  gauge (name, value, tag) {
    client && client.gauge(name, value, tag)
  },

  increment (name, tag, monotonic) {
    this.count(name, 1, tag, monotonic)
  },

  decrement (name, tag) {
    this.count(name, -1, tag)
  }
}

function reset () {
  interval = null
  client = null
  time = null
  cpuUsage = null
  nativeMetrics = null
  gcObserver && gcObserver.disconnect()
  gcObserver = null
}

function captureCpuUsage () {
  if (!process.cpuUsage) return

  const elapsedTime = process.hrtime(time)
  const elapsedUsage = process.cpuUsage(cpuUsage)

  time = process.hrtime()
  cpuUsage = process.cpuUsage()

  const elapsedMs = elapsedTime[0] * 1000 + elapsedTime[1] / 1_000_000
  const userPercent = 100 * elapsedUsage.user / 1000 / elapsedMs
  const systemPercent = 100 * elapsedUsage.system / 1000 / elapsedMs
  const totalPercent = userPercent + systemPercent

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

  stats.external && client.gauge('runtime.node.mem.external', stats.external)
}

function captureProcess () {
  client.gauge('runtime.node.process.uptime', Math.round(process.uptime()))
}

function captureHeapStats () {
  const stats = v8.getHeapStatistics()

  client.gauge('runtime.node.heap.total_heap_size', stats.total_heap_size)
  client.gauge('runtime.node.heap.total_heap_size_executable', stats.total_heap_size_executable)
  client.gauge('runtime.node.heap.total_physical_size', stats.total_physical_size)
  client.gauge('runtime.node.heap.total_available_size', stats.total_available_size)
  client.gauge('runtime.node.heap.heap_size_limit', stats.heap_size_limit)

  stats.malloced_memory && client.gauge('runtime.node.heap.malloced_memory', stats.malloced_memory)
  stats.peak_malloced_memory && client.gauge('runtime.node.heap.peak_malloced_memory', stats.peak_malloced_memory)
}

function captureHeapSpace () {
  if (!v8.getHeapSpaceStatistics) return

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
 * Gathers and reports Event Loop Utilization (ELU) since last run
 *
 * ELU is a measure of how busy the event loop is, like running JavaScript or
 * waiting on *Sync functions. The value is between 0 (idle) and 1 (exhausted).
 *
 * performance.eventLoopUtilization available in Node.js >= v14.10, >= v12.19, >= v16
 */
let captureELU = () => {}
if ('eventLoopUtilization' in performance) {
  captureELU = () => {
    // if elu is undefined (first run) the measurement is from start of process
    elu = performance.eventLoopUtilization(elu)

    client.gauge('runtime.node.event_loop.utilization', elu.utilization)
  }
}

function captureCommonMetrics () {
  captureMemoryUsage()
  captureProcess()
  captureHeapStats()
  captureELU()
}

function captureNativeMetrics () {
  const stats = nativeMetrics.stats()
  const spaces = stats.heap.spaces
  const elapsedTime = process.hrtime(time)

  time = process.hrtime()

  const elapsedUs = elapsedTime[0] * 1e6 + elapsedTime[1] / 1e3
  const userPercent = 100 * stats.cpu.user / elapsedUs
  const systemPercent = 100 * stats.cpu.system / elapsedUs
  const totalPercent = userPercent + systemPercent

  client.gauge('runtime.node.cpu.system', systemPercent.toFixed(2))
  client.gauge('runtime.node.cpu.user', userPercent.toFixed(2))
  client.gauge('runtime.node.cpu.total', totalPercent.toFixed(2))

  histogram('runtime.node.event_loop.delay', stats.eventLoop)

  Object.keys(stats.gc).forEach(type => {
    if (type === 'all') {
      histogram('runtime.node.gc.pause', stats.gc[type])
    } else {
      histogram('runtime.node.gc.pause.by.type', stats.gc[type], `gc_type:${type}`)
    }
  })

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

      runtimeMetrics.histogram('runtime.node.gc.pause.by.type', entry.duration, `gc_type:${type}`)
      runtimeMetrics.histogram('runtime.node.gc.pause', entry.duration)
    }
  })

  gcObserver.observe({ type: 'gc' })
}

function gcType (kind) {
  if (NODE_MAJOR >= 22) {
    switch (kind) {
      case 1: return 'scavenge'
      case 2: return 'minor_mark_sweep'
      case 4: return 'mark_sweep_compact' // Deprecated, might be removed soon.
      case 8: return 'incremental_marking'
      case 16: return 'process_weak_callbacks'
      case 31: return 'all'
    }
  } else if (NODE_MAJOR >= 18) {
    switch (kind) {
      case 1: return 'scavenge'
      case 2: return 'minor_mark_compact'
      case 4: return 'mark_sweep_compact'
      case 8: return 'incremental_marking'
      case 16: return 'process_weak_callbacks'
      case 31: return 'all'
    }
  } else {
    switch (kind) {
      case 1: return 'scavenge'
      case 2: return 'mark_sweep_compact'
      case 4: return 'incremental_marking'
      case 8: return 'process_weak_callbacks'
      case 15: return 'all'
    }
  }

  return 'unknown'
}
