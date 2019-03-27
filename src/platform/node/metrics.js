'use strict'

const v8 = require('v8')
const path = require('path')
const log = require('../../log')

const INTERVAL = 10 * 1000

let nativeMetrics = null

let metrics
let interval
let client
let time
let cpuUsage
let counters

reset()

module.exports = function () {
  return metrics || (metrics = { // cache the metrics instance
    start: (options) => {
      const StatsD = require('hot-shots')

      options = options || {}

      try {
        nativeMetrics = require('node-gyp-build')(path.join(__dirname, '..', '..', '..'))
        nativeMetrics.start(options.debug)
      } catch (e) {
        log.error('Unable to load native metrics module. Some metrics will not be available.')
      }

      client = new StatsD({
        host: this._config.hostname,
        port: 8125, // TODO: allow to configure this
        prefix: 'runtime.node.',
        globalTags: {
          'env': this._config.env,
          'service': this._config.service,
          'runtime-id': this._config.runtimeId
        },
        errorHandler: () => {}
      })

      time = process.hrtime()

      if (nativeMetrics) {
        interval = setInterval(() => {
          captureCommonMetrics(options.debug)
          captureNativeMetrics(options.debug)
        }, INTERVAL)
      } else {
        cpuUsage = process.cpuUsage()

        interval = setInterval(() => {
          captureCommonMetrics(options.debug)
          captureCpuUsage(options.debug)
          captureHeapSpace(options.debug)
        }, INTERVAL)
      }

      interval.unref()
    },

    stop: () => {
      if (nativeMetrics) {
        nativeMetrics.stop()
      }

      clearInterval(interval)
      reset()
    },

    track (span) {
      if (nativeMetrics) {
        nativeMetrics.track(span)
      }
    },

    increment: (name, count) => {
      if (!client) return

      counters[name] = (counters[name] || 0) + (count || 1)
    },

    decrement: (name, count) => {
      if (!client) return

      counters[name] = (counters[name] || 0) - (count || 1)
    }
  })
}

function reset () {
  interval = null
  client = null
  time = null
  cpuUsage = null
  counters = {}
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

  client.gauge('cpu.system', systemPercent.toFixed(2))
  client.gauge('cpu.user', userPercent.toFixed(2))
  client.gauge('cpu.total', totalPercent.toFixed(2))
}

function captureMemoryUsage () {
  const stats = process.memoryUsage()

  client.gauge('mem.heap_total', stats.heapTotal)
  client.gauge('mem.heap_used', stats.heapUsed)
  client.gauge('mem.rss', stats.rss)

  stats.external && client.gauge('mem.external', stats.external)
}

function captureProcess () {
  client.gauge('process.uptime', Math.round(process.uptime()))
}

function captureHeapStats () {
  const stats = v8.getHeapStatistics()

  client.gauge('heap.total_heap_size', stats.total_heap_size)
  client.gauge('heap.total_heap_size_executable', stats.total_heap_size_executable)
  client.gauge('heap.total_physical_size', stats.total_physical_size)
  client.gauge('heap.total_available_size', stats.total_available_size)
  client.gauge('heap.total_heap_size', stats.total_heap_size)
  client.gauge('heap.heap_size_limit', stats.heap_size_limit)

  stats.malloced_memory && client.gauge('heap.malloced_memory', stats.malloced_memory)
  stats.peak_malloced_memory && client.gauge('heap.peak_malloced_memory', stats.peak_malloced_memory)
}

function captureHeapSpace (debug) {
  if (!debug || !v8.getHeapSpaceStatistics) return

  const stats = v8.getHeapSpaceStatistics()

  for (let i = 0, l = stats.length; i < l; i++) {
    const tags = { 'heap.space': stats[i].space_name }

    client.gauge('heap.space.size', stats[i].space_size, tags)
    client.gauge('heap.space.used_size', stats[i].space_used_size, tags)
    client.gauge('heap.space.available_size', stats[i].space_available_size, tags)
    client.gauge('heap.physical_size', stats[i].physical_space_size, tags)
  }
}

function captureCounters () {
  Object.keys(counters).forEach(name => {
    client.gauge(name, counters[name])
  })
}

function captureCommonMetrics () {
  captureMemoryUsage()
  captureProcess()
  captureHeapStats()
  captureCounters()
}

function captureNativeMetrics (debug) {
  const stats = nativeMetrics.stats()
  const spaces = stats.heap.spaces
  const elapsedTime = process.hrtime(time)

  time = process.hrtime()

  const elapsedUs = elapsedTime[0] * 1e6 + elapsedTime[1] / 1e3
  const userPercent = 100 * stats.cpu.user / elapsedUs
  const systemPercent = 100 * stats.cpu.system / elapsedUs
  const totalPercent = userPercent + systemPercent

  client.gauge('cpu.system', systemPercent.toFixed(2))
  client.gauge('cpu.user', userPercent.toFixed(2))
  client.gauge('cpu.total', totalPercent.toFixed(2))

  client.gauge('event_loop.latency.max', stats.eventLoop.max)
  client.gauge('event_loop.latency.min', stats.eventLoop.min)
  client.gauge('event_loop.latency.sum', stats.eventLoop.sum)
  client.gauge('event_loop.latency.avg', stats.eventLoop.avg)
  client.gauge('event_loop.latency.count', stats.eventLoop.count)

  Object.keys(stats.gc).forEach(type => {
    client.gauge(`gc.${type}.min`, stats.gc[type].min)
    client.gauge(`gc.${type}.max`, stats.gc[type].max)
    client.gauge(`gc.${type}.sum`, stats.gc[type].sum)
    client.gauge(`gc.${type}.avg`, stats.gc[type].avg)
    client.gauge(`gc.${type}.count`, stats.gc[type].count)
  })

  client.gauge('spans', stats.spans.total)

  if (debug) {
    for (let i = 0, l = spaces.length; i < l; i++) {
      const tags = { 'space.name': spaces[i].space_name }

      client.gauge('heap.space.size', spaces[i].space_size, tags)
      client.gauge('heap.space.used_size', spaces[i].space_used_size, tags)
      client.gauge('heap.space.available_size', spaces[i].space_available_size, tags)
      client.gauge('heap.space.physical_size', spaces[i].physical_space_size, tags)
    }

    if (stats.spans.operations) {
      Object.keys(stats.spans.operations).forEach(name => {
        client.gauge(`span.${name}`, stats.spans.operations[name])
      })
    }
  }
}
