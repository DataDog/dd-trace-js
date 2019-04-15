'use strict'

// TODO: capture every second and flush every 10 seconds

const v8 = require('v8')
const path = require('path')
const Client = require('./dogstatsd')
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
      const tags = [
        `service:${this._config.service}`,
        `runtime-id:${this.runtime().id()}`
      ]

      if (this._config.env) {
        tags.push(`env:${this._config.env}`)
      }

      options = options || {}

      try {
        nativeMetrics = require('node-gyp-build')(path.join(__dirname, '..', '..', '..'))
        nativeMetrics.start()
      } catch (e) {
        log.error('Unable to load native metrics module. Some metrics will not be available.')
      }

      client = new Client({
        host: this._config.hostname,
        port: this._config.dogstatsd.port,
        prefix: 'runtime.node.',
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

    count (name, count, tag) {
      if (!client) return
      if (!counters[name]) {
        counters[name] = tag ? Object.create(null) : 0
      }

      if (tag) {
        counters[name][tag] = (counters[name][tag] || 0) + count
      } else {
        counters[name] = (counters[name] || 0) + count
      }
    },

    increment (name, tag) {
      this.count(name, 1, tag)
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
  client.gauge('heap.heap_size_limit', stats.heap_size_limit)

  stats.malloced_memory && client.gauge('heap.malloced_memory', stats.malloced_memory)
  stats.peak_malloced_memory && client.gauge('heap.peak_malloced_memory', stats.peak_malloced_memory)
}

function captureHeapSpace () {
  if (!v8.getHeapSpaceStatistics) return

  const stats = v8.getHeapSpaceStatistics()

  for (let i = 0, l = stats.length; i < l; i++) {
    const tags = [`space:${stats[i].space_name}`]

    client.gauge('heap.size.by.space', stats[i].space_size, tags)
    client.gauge('heap.used_size.by.space', stats[i].space_used_size, tags)
    client.gauge('heap.available_size.by.space', stats[i].space_available_size, tags)
    client.gauge('heap.physical_size.by.space', stats[i].physical_space_size, tags)
  }
}

function captureCounters () {
  Object.keys(counters).forEach(name => {
    if (typeof counters[name] === 'object') {
      Object.keys(counters[name]).forEach(tag => {
        client.gauge(name, counters[name][tag], [tag])
      })
    } else {
      client.gauge(name, counters[name])
    }
  })
}

function captureCommonMetrics () {
  captureMemoryUsage()
  captureProcess()
  captureHeapStats()
  captureCounters()
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

  client.gauge('cpu.system', systemPercent.toFixed(2))
  client.gauge('cpu.user', userPercent.toFixed(2))
  client.gauge('cpu.total', totalPercent.toFixed(2))

  histogram('event_loop.delay', stats.eventLoop)

  Object.keys(stats.gc).forEach(type => {
    if (type === 'all') {
      histogram('gc.pause', stats.gc[type])
    } else {
      histogram('gc.pause.by.type', stats.gc[type], { gc_type: type })
    }
  })

  client.gauge('spans.finished', stats.spans.total.finished)
  client.gauge('spans.unfinished', stats.spans.total.unfinished)

  for (let i = 0, l = spaces.length; i < l; i++) {
    const tags = [`heap_space:${spaces[i].space_name}`]

    client.gauge('heap.size.by.space', spaces[i].space_size, tags)
    client.gauge('heap.used_size.by.space', spaces[i].space_used_size, tags)
    client.gauge('heap.available_size.by.space', spaces[i].space_available_size, tags)
    client.gauge('heap.physical_size.by.space', spaces[i].physical_space_size, tags)
  }

  if (stats.spans.operations) {
    const operations = stats.spans.operations

    Object.keys(operations.finished).forEach(name => {
      client.gauge('spans.finished.by.name', operations.finished[name], [`span_name:${name}`])
    })

    Object.keys(operations.unfinished).forEach(name => {
      client.gauge('spans.unfinished.by.name', operations.unfinished[name], [`span_name:${name}`])
    })
  }
}

function histogram (name, stats) {
  client.gauge(`${name}.min`, stats.min)
  client.gauge(`${name}.max`, stats.max)
  client.increment(`${name}.sum`, stats.sum)
  client.gauge(`${name}.avg`, stats.avg)
  client.increment(`${name}.count`, stats.count)
  client.gauge(`${name}.median`, stats.median)
  client.gauge(`${name}.95percentile`, stats.p95)
}
