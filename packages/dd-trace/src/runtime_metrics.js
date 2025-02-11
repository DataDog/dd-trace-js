'use strict'

// TODO: capture every second and flush every 10 seconds

const v8 = require('v8')
const os = require('os')
const { DogStatsDClient } = require('./dogstatsd')
const log = require('./log')
const Histogram = require('./histogram')
const { performance, PerformanceObserver } = require('perf_hooks')

const { NODE_MAJOR, NODE_MINOR } = require('../../../version')
const INTERVAL = 10 * 1000

// Node >=16 has PerformanceObserver with `gc` type, but <16.7 had a critical bug.
// See: https://github.com/nodejs/node/issues/39548
const hasGCObserver = NODE_MAJOR >= 18 || (NODE_MAJOR === 16 && NODE_MINOR >= 7)
const hasGCProfiler = NODE_MAJOR >= 20 || (NODE_MAJOR === 18 && NODE_MINOR >= 15)

let nativeMetrics = null
let gcObserver = null
let gcProfiler = null

let interval
let client
let time
let cpuUsage
let gauges
let counters
let histograms
let elu

reset()

const runtimeMetrics = module.exports = {
  start (config) {
    const clientConfig = DogStatsDClient.generateClientConfig(config)

    try {
      nativeMetrics = require('@datadog/native-metrics')

      if (hasGCObserver) {
        nativeMetrics.start('loop') // Only add event loop watcher and not GC.
      } else {
        nativeMetrics.start()
      }
    } catch (e) {
      log.error('Error starting native metrics', e)
      nativeMetrics = null
    }

    client = new DogStatsDClient(clientConfig)

    time = process.hrtime()

    startGCObserver()
    startGCProfiler()

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
    this.gauge(name, value ? 1 : 0, tag)
  },

  histogram (name, value, tag) {
    if (!client) return

    histograms[name] = histograms[name] || new Map()

    if (!histograms[name].has(tag)) {
      histograms[name].set(tag, new Histogram())
    }

    histograms[name].get(tag).record(value)
  },

  count (name, count, tag, monotonic = false) {
    if (!client) return
    if (typeof tag === 'boolean') {
      monotonic = tag
      tag = undefined
    }

    const map = monotonic ? counters : gauges

    map[name] = map[name] || new Map()

    const value = map[name].get(tag) || 0

    map[name].set(tag, value + count)
  },

  gauge (name, value, tag) {
    if (!client) return

    gauges[name] = gauges[name] || new Map()
    gauges[name].set(tag, value)
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
  gauges = {}
  counters = {}
  histograms = {}
  nativeMetrics = null
  gcObserver && gcObserver.disconnect()
  gcObserver = null
  gcProfiler && gcProfiler.stop()
  gcProfiler = null
}

function captureCpuUsage () {
  if (!process.cpuUsage) return

  const elapsedTime = process.hrtime(time)
  const elapsedUsage = process.cpuUsage(cpuUsage)

  time = process.hrtime()
  cpuUsage = process.cpuUsage()

  const elapsedMs = elapsedTime[0] * 1000 + elapsedTime[1] / 1000000
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
function captureGCMetrics () {
  if (!gcProfiler) return

  const profile = gcProfiler.stop()
  const pauseAll = new Histogram()
  const pause = {}

  for (const stat of profile.statistics) {
    const type = stat.gcType.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()

    pause[type] = pause[type] || new Histogram()
    pause[type].record(stat.cost)
    pauseAll.record(stat.cost)
  }

  histogram('runtime.node.gc.pause', pauseAll)

  for (const type in pause) {
    histogram('runtime.node.gc.pause.by.type', pause[type], [`gc_type:${type}`])
  }

  gcProfiler.start()
}

function captureGauges () {
  Object.keys(gauges).forEach(name => {
    gauges[name].forEach((value, tag) => {
      client.gauge(name, value, tag && [tag])
    })
  })
}

function captureCounters () {
  Object.keys(counters).forEach(name => {
    counters[name].forEach((value, tag) => {
      client.increment(name, value, tag && [tag])
    })
  })

  counters = {}
}

function captureHistograms () {
  Object.keys(histograms).forEach(name => {
    histograms[name].forEach((stats, tag) => {
      histogram(name, stats, tag && [tag])
      stats.reset()
    })
  })
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
  captureGauges()
  captureCounters()
  captureHistograms()
  captureELU()
  captureGCMetrics()
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
      histogram('runtime.node.gc.pause.by.type', stats.gc[type], [`gc_type:${type}`])
    }
  })

  for (let i = 0, l = spaces.length; i < l; i++) {
    const tags = [`heap_space:${spaces[i].space_name}`]

    client.gauge('runtime.node.heap.size.by.space', spaces[i].space_size, tags)
    client.gauge('runtime.node.heap.used_size.by.space', spaces[i].space_used_size, tags)
    client.gauge('runtime.node.heap.available_size.by.space', spaces[i].space_available_size, tags)
    client.gauge('runtime.node.heap.physical_size.by.space', spaces[i].physical_space_size, tags)
  }
}

function histogram (name, stats, tags) {
  tags = [].concat(tags)

  // Stats can contain garbage data when a value was never recorded.
  if (stats.count === 0) {
    stats = { max: 0, min: 0, sum: 0, avg: 0, median: 0, p95: 0, count: 0 }
  }

  client.gauge(`${name}.min`, stats.min, tags)
  client.gauge(`${name}.max`, stats.max, tags)
  client.increment(`${name}.sum`, stats.sum, tags)
  client.increment(`${name}.total`, stats.sum, tags)
  client.gauge(`${name}.avg`, stats.avg, tags)
  client.increment(`${name}.count`, stats.count, tags)
  client.gauge(`${name}.median`, stats.median, tags)
  client.gauge(`${name}.95percentile`, stats.p95, tags)
}

function startGCObserver () {
  if (gcObserver || hasGCProfiler || !hasGCObserver) return

  gcObserver = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) {
      const type = gcType(entry.detail?.kind || entry.kind)

      runtimeMetrics.histogram('runtime.node.gc.pause.by.type', entry.duration, `gc_type:${type}`)
      runtimeMetrics.histogram('runtime.node.gc.pause', entry.duration)
    }
  })

  gcObserver.observe({ type: 'gc' })
}

function startGCProfiler () {
  if (gcProfiler || !hasGCProfiler) return

  gcProfiler = new v8.GCProfiler()
  gcProfiler.start()
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
