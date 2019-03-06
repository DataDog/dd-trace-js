'use strict'

const v8 = require('v8')
const StatsD = require('hot-shots')
const log = require('../../log')

let eventLoopStats = null
let gcStats = null

// TODO: test for this binding
// TODO: test for cpuUsage

try {
  eventLoopStats = require('event-loop-stats')
} catch (e) {
  log.error('Unable to load event-loop-stats. Event loop metrics will not be available.')
}

try {
  gcStats = require('gc-stats')()
} catch (e) {
  log.error('Unable to load gc-stats. Garbage collection metrics will not be available.')
}

let interval
let client
let time
let cpuUsage
let counters

const gcTypes = {
  1: 'Scavenge',
  2: 'MarkSweepCompact',
  3: 'All', // Node 4
  4: 'IncrementalMarking',
  8: 'ProcessWeakCallbacks',
  15: 'All'
}

reset()

module.exports = function () {
  return {
    start: () => {
      client = new StatsD({
        host: this._config.hostname,
        port: 8125, // TODO: allow to configure this
        prefix: 'nodejs.',
        globalTags: {
          'env': this._config.env,
          'service': this._config.service,
          'runtime-id': this._config.runtimeId
        },
        errorHandler: () => {}
      })

      time = process.hrtime()
      cpuUsage = process.cpuUsage()

      gcStats && gcStats.addListener('stats', onGcStats)

      interval = setInterval(() => {
        captureCpuUsage()
        captureMemoryUsage()
        captureProcess()
        captureHeapStats()
        captureHeapSpace()
        captureCounters()
        captureEventLoop()
      }, 1000)

      interval.unref()
    },

    stop: () => {
      clearInterval(interval)
      reset()
    },

    increment: (name) => {
      if (!client) return

      if (counters[name] !== undefined) {
        counters[name]++
      } else {
        counters[name] = 1
      }
    },

    decrement: (name) => {
      if (!client) return

      if (counters[name] !== undefined) {
        counters[name]--
      } else {
        counters[name] = -1
      }
    }
  }
}

function reset () {
  interval = null
  client = null
  time = null
  cpuUsage = null
  counters = {}
  gcStats && gcStats.removeListener('stats', onGcStats)
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

function captureHeapSpace () {
  if (!v8.getHeapSpaceStatistics) return

  const stats = v8.getHeapSpaceStatistics()

  for (let i = 0, l = stats.length; i < l; i++) {
    const tags = { 'heap.space': stats[i].space_name }

    client.gauge('heap.space_size', stats[i].space_size, tags)
    client.gauge('heap.space_used_size', stats[i].space_used_size, tags)
    client.gauge('heap.space_available_size', stats[i].space_available_size, tags)
    client.gauge('heap.physical_space_size', stats[i].physical_space_size, tags)
  }
}

function captureCounters () {
  Object.keys(counters).forEach(name => {
    client.gauge(name, counters[name])
  })
}

function captureEventLoop () {
  if (!eventLoopStats) return

  const stats = eventLoopStats.sense()

  client.gauge('event_loop.tick.max', stats.max)
  client.gauge('event_loop.tick.min', stats.min)
  client.gauge('event_loop.tick.avg', stats.sum / stats.num)
  client.gauge('event_loop.tick.count', stats.num)
}

function onGcStats (stats) {
  client.gauge('gc.pause.time', stats.pause / 1e6, {
    'gc.type': gcTypes[stats.gctype]
  })

  client.increment('gc.pause.count', {
    'gc.type': gcTypes[stats.gctype]
  })
}
