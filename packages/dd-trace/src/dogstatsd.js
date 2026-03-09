'use strict'

const lookup = require('dns').lookup // cache to avoid instrumentation
const dgram = require('dgram')
const isIP = require('net').isIP

const request = require('./exporters/common/request')
const log = require('./log')
const Histogram = require('./histogram')
const defaults = require('./config/defaults')
const { getAgentUrl } = require('./agent/url')
const { entityId } = require('./exporters/common/docker')

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
  #httpOptions
  #host
  #family
  #port
  #prefix
  #tags
  #queue = []
  #buffer = ''
  #offset = 0
  #udp4
  #udp6

  constructor (options = {}) {
    if (options.metricsProxyUrl) {
      this.#httpOptions = {
        url: options.metricsProxyUrl.toString(),
        path: '/dogstatsd/v2/proxy',
      }
    }

    this.#host = options.host || defaults['dogstatsd.hostname']
    this.#family = isIP(this.#host)
    this.#port = options.port || defaults['dogstatsd.port']
    this.#prefix = options.prefix || ''
    this.#tags = options.tags || []
    this.#udp4 = this._socket('udp4')
    this.#udp6 = this._socket('udp6')
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

    log.debug('Flushing %s metrics via', queue.length, this.#httpOptions ? 'HTTP' : 'UDP')

    if (this.#queue.length === 0) return

    this.#queue = []

    if (this.#httpOptions) {
      this._sendHttp(queue)
    } else {
      this._sendUdp(queue)
    }
  }

  _sendHttp (queue) {
    const buffer = Buffer.concat(queue)
    request(buffer, this.#httpOptions, (err) => {
      if (err) {
        log.error('DogStatsDClient: HTTP error from agent: %s', err.message, err)
        if (err.status === 404) {
          // Inside this if-block, we have connectivity to the agent, but
          // we're not getting a 200 from the proxy endpoint. If it's a 404,
          // then we know we'll never have the endpoint, so just clear out the
          // options. Either way, we can give UDP a try.
          this.#httpOptions = undefined
        }
        this._sendUdp(queue)
      }
    })
  }

  _sendUdp (queue) {
    if (this.#family === 0) {
      lookup(this.#host, (err, address, family) => {
        if (err) return log.error('DogStatsDClient: Host not found', err)
        this._sendUdpFromQueue(queue, address, family)
      })
    } else {
      this._sendUdpFromQueue(queue, this.#host, this.#family)
    }
  }

  _sendUdpFromQueue (queue, address, family) {
    const socket = family === 6 ? this.#udp6 : this.#udp4

    for (const buffer of queue) {
      log.debug('Sending to DogStatsD: %s', buffer)
      socket.send(buffer, 0, buffer.length, this.#port, address)
    }
  }

  _add (stat, value, type, tags) {
    let message = `${this.#prefix + stat}:${value}|${type}`

    // Don't manipulate this.#tags as it is still used
    tags = tags ? [...this.#tags, ...tags] : this.#tags

    if (tags.length > 0) {
      message += `|#${tags.join(',')}`
    }

    if (entityId) {
      message += `|c:${entityId}`
    }

    this._write(`${message}\n`)
  }

  _write (message) {
    const offset = Buffer.byteLength(message)

    if (this.#offset + offset > MAX_BUFFER_SIZE) {
      this._enqueue()
    }

    this.#offset += offset
    this.#buffer += message
  }

  _enqueue () {
    if (this.#offset > 0) {
      this.#queue.push(Buffer.from(this.#buffer))
      this.#buffer = ''
      this.#offset = 0
    }

    return this.#queue
  }

  _socket (type) {
    const socket = dgram.createSocket(type)

    socket.on('error', () => {})
    socket.unref()

    return socket
  }

  static generateClientConfig (config) {
    const tags = []

    if (config.tags) {
      for (const [key, value] of Object.entries(config.tags)) {
        // Skip runtime-id unless enabled as cardinality may be too high
        if (typeof value === 'string' && (key !== 'runtime-id' || config.runtimeMetricsRuntimeId)) {
          // https://docs.datadoghq.com/tagging/#defining-tags
          const valueStripped = value.replaceAll(/[^a-z0-9_:./-]/ig, '_')

          tags.push(`${key}:${valueStripped}`)
        }
      }
    }

    const clientConfig = {
      host: config.dogstatsd.hostname,
      port: config.dogstatsd.port,
      tags,
    }

    if (config.url || config.port) {
      clientConfig.metricsProxyUrl = getAgentUrl(config)
    }

    return clientConfig
  }
}

class MetricsAggregationClient {
  #client
  #counters
  #gauges
  #histograms

  constructor (client) {
    this.#client = client

    this.reset()
  }

  flush () {
    this._captureCounters()
    this._captureGauges()
    this._captureHistograms()

    this.#client.flush()
  }

  reset () {
    this.#counters = new Map()
    this.#gauges = new Map()
    this.#histograms = new Map()
  }

  // TODO: Aggregate with a histogram and send the buckets to the client.
  distribution (name, value, tags) {
    this.#client.distribution(name, value, tags)
  }

  boolean (name, value, tags) {
    this.gauge(name, value ? 1 : 0, tags)
  }

  histogram (name, value, tags) {
    const node = this._ensureTree(this.#histograms, name, tags, null)

    if (!node.value) {
      node.value = new Histogram()
    }

    node.value.record(value)
  }

  count (name, count, tags = [], monotonic = true) {
    if (typeof tags === 'boolean') {
      monotonic = tags
      tags = []
    }

    const container = monotonic ? this.#counters : this.#gauges
    const node = this._ensureTree(container, name, tags, 0)

    node.value += count
  }

  gauge (name, value, tags) {
    const node = this._ensureTree(this.#gauges, name, tags, 0)

    node.value = value
  }

  increment (name, count = 1, tags) {
    this.count(name, count, tags)
  }

  decrement (name, count = 1, tags) {
    this.count(name, -count, tags)
  }

  _captureGauges () {
    this._captureTree(this.#gauges, (node, name, tags) => {
      this.#client.gauge(name, node.value, tags)
    })
  }

  _captureCounters () {
    this._captureTree(this.#counters, (node, name, tags) => {
      this.#client.increment(name, node.value, tags)
    })

    this.#counters.clear()
  }

  _captureHistograms () {
    this._captureTree(this.#histograms, (node, name, tags) => {
      let stats = node.value

      // Stats can contain garbage data when a value was never recorded.
      if (stats.count === 0) {
        stats = { max: 0, min: 0, sum: 0, avg: 0, median: 0, p95: 0, count: 0 }
      }

      this.#client.gauge(`${name}.min`, stats.min, tags)
      this.#client.gauge(`${name}.max`, stats.max, tags)
      this.#client.increment(`${name}.sum`, stats.sum, tags)
      this.#client.increment(`${name}.total`, stats.sum, tags)
      this.#client.gauge(`${name}.avg`, stats.avg, tags)
      this.#client.increment(`${name}.count`, stats.count, tags)
      this.#client.gauge(`${name}.median`, stats.median, tags)
      this.#client.gauge(`${name}.95percentile`, stats.p95, tags)

      node.value.reset()
    })
  }

  _captureTree (tree, fn) {
    for (const [name, root] of tree) {
      this._captureNode(root, name, [], fn)
    }
  }

  _captureNode (node, name, tags, fn) {
    if (node.touched) {
      fn(node, name, tags)
    }

    for (const [tag, next] of node.nodes) {
      tags.push(tag)
      this._captureNode(next, name, tags, fn)
      tags.pop()
    }
  }

  _ensureTree (tree, name, tags = [], value) {
    if (!Array.isArray(tags)) {
      tags = [tags]
    }

    let node = this._ensureNode(tree, name, value)

    for (const tag of tags) {
      node = this._ensureNode(node.nodes, tag, value)
    }

    node.touched = true

    return node
  }

  _ensureNode (container, key, value) {
    let node = container.get(key)

    if (!node) {
      node = { nodes: new Map(), touched: false, value }

      if (typeof key === 'string') {
        container.set(key, node)
      }
    }

    return node
  }
}

/**
 * This is a simplified user-facing proxy to the underlying DogStatsDClient instance
 *
 * @implements {DogStatsD}
 */
class CustomMetrics {
  #client
  constructor (config) {
    const clientConfig = DogStatsDClient.generateClientConfig(config)
    this.#client = new MetricsAggregationClient(new DogStatsDClient(clientConfig))

    const flush = this.flush.bind(this)

    // TODO(bengl) this magic number should be configurable
    setInterval(flush, 10 * 1000).unref()

    globalThis[Symbol.for('dd-trace')].beforeExitHandlers.add(flush)
  }

  increment (stat, value = 1, tags) {
    this.#client.increment(stat, value, CustomMetrics.tagTranslator(tags))
  }

  decrement (stat, value = 1, tags) {
    this.#client.decrement(stat, value, CustomMetrics.tagTranslator(tags))
  }

  gauge (stat, value, tags) {
    this.#client.gauge(stat, value, CustomMetrics.tagTranslator(tags))
  }

  distribution (stat, value, tags) {
    this.#client.distribution(stat, value, CustomMetrics.tagTranslator(tags))
  }

  histogram (stat, value, tags) {
    this.#client.histogram(stat, value, CustomMetrics.tagTranslator(tags))
  }

  flush () {
    return this.#client.flush()
  }

  /**
   * Exposing { tagName: 'tagValue' } to the end user
   * These are translated into [ 'tagName:tagValue' ] for internal use
   */
  static tagTranslator (objTags) {
    if (Array.isArray(objTags)) return objTags

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
  MetricsAggregationClient,
}
