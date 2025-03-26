'use strict'

const lookup = require('dns').lookup // cache to avoid instrumentation
const request = require('./exporters/common/request')
const dgram = require('dgram')
const isIP = require('net').isIP
const log = require('./log')
const { URL, format } = require('url')
const Histogram = require('./histogram')

const MAX_BUFFER_SIZE = 1024 // limit from the agent

const TYPE_COUNTER = 'c'
const TYPE_GAUGE = 'g'
const TYPE_DISTRIBUTION = 'd'
const TYPE_HISTOGRAM = 'h'

/**
 * @import { DogStatsD } from "../../../index.d.ts"
 * @implements {DogStatsD}
 */
class DogStatsDClient {
  constructor (options = {}) {
    if (options.metricsProxyUrl) {
      this._httpOptions = {
        url: options.metricsProxyUrl.toString(),
        path: '/dogstatsd/v2/proxy'
      }
    }

    this._host = options.host || 'localhost'
    this._family = isIP(this._host)
    this._port = options.port || 8125
    this._prefix = options.prefix || ''
    this._tags = options.tags || []
    this._queue = []
    this._buffer = ''
    this._offset = 0
    this._udp4 = this._socket('udp4')
    this._udp6 = this._socket('udp6')
  }

  increment (stat, value, tags) {
    this._add(stat, value, TYPE_COUNTER, tags)
  }

  decrement (stat, value, tags) {
    this._add(stat, -value, TYPE_COUNTER, tags)
  }

  gauge (stat, value, tags) {
    this._add(stat, value, TYPE_GAUGE, tags)
  }

  distribution (stat, value, tags) {
    this._add(stat, value, TYPE_DISTRIBUTION, tags)
  }

  histogram (stat, value, tags) {
    this._add(stat, value, TYPE_HISTOGRAM, tags)
  }

  flush () {
    const queue = this._enqueue()

    log.debug(`Flushing ${queue.length} metrics via ${this._httpOptions ? 'HTTP' : 'UDP'}`)

    if (this._queue.length === 0) return

    this._queue = []

    if (this._httpOptions) {
      this._sendHttp(queue)
    } else {
      this._sendUdp(queue)
    }
  }

  _sendHttp (queue) {
    const buffer = Buffer.concat(queue)
    request(buffer, this._httpOptions, (err) => {
      if (err) {
        log.error('DogStatsDClient: HTTP error from agent: %s', err.message, err)
        if (err.status === 404) {
          // Inside this if-block, we have connectivity to the agent, but
          // we're not getting a 200 from the proxy endpoint. If it's a 404,
          // then we know we'll never have the endpoint, so just clear out the
          // options. Either way, we can give UDP a try.
          this._httpOptions = undefined
        }
        this._sendUdp(queue)
      }
    })
  }

  _sendUdp (queue) {
    if (this._family !== 0) {
      this._sendUdpFromQueue(queue, this._host, this._family)
    } else {
      lookup(this._host, (err, address, family) => {
        if (err) return log.error('DogStatsDClient: Host not found', err)
        this._sendUdpFromQueue(queue, address, family)
      })
    }
  }

  _sendUdpFromQueue (queue, address, family) {
    const socket = family === 6 ? this._udp6 : this._udp4

    queue.forEach((buffer) => {
      log.debug(`Sending to DogStatsD: ${buffer}`)
      socket.send(buffer, 0, buffer.length, this._port, address)
    })
  }

  _add (stat, value, type, tags) {
    const message = `${this._prefix + stat}:${value}|${type}`

    tags = tags ? this._tags.concat(tags) : this._tags

    if (tags.length > 0) {
      this._write(`${message}|#${tags.join(',')}\n`)
    } else {
      this._write(`${message}\n`)
    }
  }

  _write (message) {
    const offset = Buffer.byteLength(message)

    if (this._offset + offset > MAX_BUFFER_SIZE) {
      this._enqueue()
    }

    this._offset += offset
    this._buffer += message
  }

  _enqueue () {
    if (this._offset > 0) {
      this._queue.push(Buffer.from(this._buffer))
      this._buffer = ''
      this._offset = 0
    }

    return this._queue
  }

  _socket (type) {
    const socket = dgram.createSocket(type)

    socket.on('error', () => {})
    socket.unref()

    return socket
  }

  static generateClientConfig (config = {}) {
    const tags = []

    if (config.tags) {
      Object.keys(config.tags)
        .filter(key => typeof config.tags[key] === 'string')
        .filter(key => {
          // Skip runtime-id unless enabled as cardinality may be too high
          if (key !== 'runtime-id') return true
          return (config.experimental && config.experimental.runtimeId)
        })
        .forEach(key => {
          // https://docs.datadoghq.com/tagging/#defining-tags
          const value = config.tags[key].replace(/[^a-z0-9_:./-]/ig, '_')

          tags.push(`${key}:${value}`)
        })
    }

    const clientConfig = {
      host: config.dogstatsd.hostname,
      port: config.dogstatsd.port,
      tags
    }

    if (config.url) {
      clientConfig.metricsProxyUrl = config.url
    } else if (config.port) {
      clientConfig.metricsProxyUrl = new URL(format({
        protocol: 'http:',
        hostname: config.hostname || 'localhost',
        port: config.port
      }))
    }

    return clientConfig
  }
}

// TODO: Handle arrays of tags and tags translation.
class MetricsAggregationClient {
  constructor (client) {
    this._client = client

    this.reset()
  }

  flush () {
    this._captureCounters()
    this._captureGauges()
    this._captureHistograms()

    this._client.flush()
  }

  reset () {
    this._counters = {}
    this._gauges = {}
    this._histograms = {}
  }

  distribution (name, value, tag) {
    this._client.distribution(name, value, tag && [tag])
  }

  boolean (name, value, tag) {
    this.gauge(name, value ? 1 : 0, tag)
  }

  histogram (name, value, tag) {
    this._histograms[name] = this._histograms[name] || new Map()

    if (!this._histograms[name].has(tag)) {
      this._histograms[name].set(tag, new Histogram())
    }

    this._histograms[name].get(tag).record(value)
  }

  count (name, count, tag, monotonic = true) {
    if (typeof tag === 'boolean') {
      monotonic = tag
      tag = undefined
    }

    const map = monotonic ? this._counters : this._gauges

    map[name] = map[name] || new Map()

    const value = map[name].get(tag) || 0

    map[name].set(tag, value + count)
  }

  gauge (name, value, tag) {
    this._gauges[name] = this._gauges[name] || new Map()
    this._gauges[name].set(tag, value)
  }

  increment (name, count = 1, tag) {
    this.count(name, count, tag)
  }

  decrement (name, count = 1, tag) {
    this.count(name, -count, tag)
  }

  _captureGauges () {
    Object.keys(this._gauges).forEach(name => {
      this._gauges[name].forEach((value, tag) => {
        this._client.gauge(name, value, tag && [tag])
      })
    })
  }

  _captureCounters () {
    Object.keys(this._counters).forEach(name => {
      this._counters[name].forEach((value, tag) => {
        this._client.increment(name, value, tag && [tag])
      })
    })

    this._counters = {}
  }

  _captureHistograms () {
    Object.keys(this._histograms).forEach(name => {
      this._histograms[name].forEach((stats, tag) => {
        const tags = tag && [tag]

        // Stats can contain garbage data when a value was never recorded.
        if (stats.count === 0) {
          stats = { max: 0, min: 0, sum: 0, avg: 0, median: 0, p95: 0, count: 0, reset: stats.reset }
        }

        this._client.gauge(`${name}.min`, stats.min, tags)
        this._client.gauge(`${name}.max`, stats.max, tags)
        this._client.increment(`${name}.sum`, stats.sum, tags)
        this._client.increment(`${name}.total`, stats.sum, tags)
        this._client.gauge(`${name}.avg`, stats.avg, tags)
        this._client.increment(`${name}.count`, stats.count, tags)
        this._client.gauge(`${name}.median`, stats.median, tags)
        this._client.gauge(`${name}.95percentile`, stats.p95, tags)

        stats.reset()
      })
    })
  }
}

/**
 * This is a simplified user-facing proxy to the underlying DogStatsDClient instance
 *
 * @implements {DogStatsD}
 */
class CustomMetrics {
  constructor (config) {
    const clientConfig = DogStatsDClient.generateClientConfig(config)
    this._client = new MetricsAggregationClient(new DogStatsDClient(clientConfig))

    const flush = this.flush.bind(this)

    // TODO(bengl) this magic number should be configurable
    setInterval(flush, 10 * 1000).unref()

    process.once('beforeExit', flush)
  }

  increment (stat, value = 1, tags) {
    for (const tag of this._normalizeTags(tags)) {
      this._client.increment(stat, value, tag)
    }
  }

  decrement (stat, value = 1, tags) {
    for (const tag of this._normalizeTags(tags)) {
      this._client.decrement(stat, value, tag)
    }
  }

  gauge (stat, value, tags) {
    for (const tag of this._normalizeTags(tags)) {
      this._client.gauge(stat, value, tag)
    }
  }

  distribution (stat, value, tags) {
    for (const tag of this._normalizeTags(tags)) {
      this._client.distribution(stat, value, tag)
    }
  }

  histogram (stat, value, tags) {
    for (const tag of this._normalizeTags(tags)) {
      this._client.histogram(stat, value, tag)
    }
  }

  flush () {
    return this._client.flush()
  }

  _normalizeTags (tags) {
    tags = CustomMetrics.tagTranslator(tags)

    return tags.length === 0 ? [undefined] : tags
  }

  /**
   * Exposing { tagName: 'tagValue' } to the end user
   * These are translated into [ 'tagName:tagValue' ] for internal use
   */
  static tagTranslator (objTags) {
    const arrTags = []

    if (!objTags) return arrTags

    for (const [key, value] of Object.entries(objTags)) {
      arrTags.push(`${key}:${value}`)
    }

    return arrTags
  }
}

module.exports = {
  DogStatsDClient,
  CustomMetrics,
  MetricsAggregationClient
}
