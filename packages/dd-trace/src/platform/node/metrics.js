'use strict'

// TODO: capture every second and flush every 10 seconds

const v8 = require('v8')
const path = require('path')
const os = require('os')
const Client = require('./dogstatsd')
const log = require('../../log')
const Histogram = require('../../histogram')

const INTERVAL = 10 * 1000

let nativeMetrics = null

let metrics
let interval
let client
let time
let cpuUsage
let gauges
let counters
let histograms

reset()

module.exports = function () {
  return metrics || (metrics = { // cache the metrics instance
    start: (options) => {
      const tags = [
        `service:${this._config.service}`
      ]

      if (this._config.env) {
        tags.push(`env:${this._config.env}`)
      }

      Object.keys(this._config.tags)
        .filter(key => typeof this._config.tags[key] === 'string')
        .forEach(key => {
          // https://docs.datadoghq.com/tagging/#defining-tags
          const value = this._config.tags[key].replace(/[^a-z0-9_:./-]/ig, '_')

          tags.push(`${key}:${value}`)
        })

      options = options || {}

      try {
        nativeMetrics = require('node-gyp-build')(path.join(__dirname, '..', '..', '..', '..', '..'))
        nativeMetrics.start()
      } catch (e) {
        log.error(e)
        nativeMetrics = null
      }

      client = new Client({
        host: this._config.hostname,
        port: this._config.dogstatsd.port,
        tags
      })

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

    stop: () => {
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
      metrics.gauge(name, value ? 1 : 0, tag)
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
  })
}

function reset () {
  interval = null
  client = null
  time = null
  cpuUsage = null
  gauges = {}
  counters = {}
  histograms = {}
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

function captureCommonMetrics () {
  captureMemoryUsage()
  captureProcess()
  captureHeapStats()
  captureGauges()
  captureCounters()
  captureHistograms()
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

  client.gauge('runtime.node.spans.finished', stats.spans.total.finished)
  client.gauge('runtime.node.spans.unfinished', stats.spans.total.unfinished)

  for (let i = 0, l = spaces.length; i < l; i++) {
    const tags = [`heap_space:${spaces[i].space_name}`]

    client.gauge('runtime.node.heap.size.by.space', spaces[i].space_size, tags)
    client.gauge('runtime.node.heap.used_size.by.space', spaces[i].space_used_size, tags)
    client.gauge('runtime.node.heap.available_size.by.space', spaces[i].space_available_size, tags)
    client.gauge('runtime.node.heap.physical_size.by.space', spaces[i].physical_space_size, tags)
  }

  if (stats.spans.operations) {
    const operations = stats.spans.operations

    Object.keys(operations.finished).forEach(name => {
      client.gauge('runtime.node.spans.finished.by.name', operations.finished[name], [`span_name:${name}`])
    })

    Object.keys(operations.unfinished).forEach(name => {
      client.gauge('runtime.node.spans.unfinished.by.name', operations.unfinished[name], [`span_name:${name}`])
    })
  }
}

function histogram (name, stats, tags) {
  tags = [].concat(tags)

  client.gauge(`${name}.min`, stats.min, tags)
  client.gauge(`${name}.max`, stats.max, tags)
  client.increment(`${name}.sum`, stats.sum, tags)
  client.increment(`${name}.total`, stats.sum, tags)
  client.gauge(`${name}.avg`, stats.avg, tags)
  client.increment(`${name}.count`, stats.count, tags)
  client.gauge(`${name}.median`, stats.median, tags)
  client.gauge(`${name}.95percentile`, stats.p95, tags)
}
