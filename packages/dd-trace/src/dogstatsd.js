'use strict'

const dgram = require('dgram')
const isIP = require('net').isIP

const request = require('./exporters/common/request')
const log = require('./log')
const Histogram = require('./histogram')
const { getAgentUrl } = require('./agent/url')
const { entityId } = require('./exporters/common/docker')

const MAX_BUFFER_SIZE = 1024 // limit from the agent

const TYPE_COUNTER = 'c'
const TYPE_GAUGE = 'g'
const TYPE_DISTRIBUTION = 'd'
const TYPE_HISTOGRAM = 'h'
const TYPE_LABEL = { c: 'count', g: 'gauge', d: 'distribution', h: 'histogram' }

/**
 * @import { DogStatsD } from "../../../index.d.ts"
 * @implements {DogStatsD}
 */
class DogStatsDClient {
  #lookup
  #tagsPrefix
  #telemetryEnabled

  #metricsSent = 0
  #metricsByType = {
    [TYPE_COUNTER]: 0,
    [TYPE_GAUGE]: 0,
    [TYPE_DISTRIBUTION]: 0,
    [TYPE_HISTOGRAM]: 0,
  }

  #bytesSent = 0
  #bytesDropped = 0
  #packetsSent = 0
  #packetsDropped = 0

  #metrics = { buffer: '', offset: 0, queue: [] }
  #telemetry = { buffer: '', offset: 0, queue: [] }

  constructor (options) {
    this.#lookup = options.lookup
    if (options.metricsProxyUrl) {
      this._httpOptions = {
        method: 'POST',
        url: options.metricsProxyUrl.toString(),
        path: '/dogstatsd/v2/proxy',
      }
    }

    // Disable self-telemetry by default
    this.#telemetryEnabled = options?.telemetry ?? false

    this._host = options.host
    this._family = isIP(this._host)
    this._port = options.port
    this._tags = options.tags
    this.#tagsPrefix = this._tags?.length ? `|#${this._tags.join(',')}` : ''
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

  /**
   * Flushes the metrics to the agent
   *
   * @param {boolean} [telemetry] - whether the payload is self-telemetry or not
   * @memberof DogStatsDClient
   */
  flush (telemetry = false) {
    this._enqueue(telemetry)
    const state = telemetry ? this.#telemetry : this.#metrics
    const queue = state.queue

    if (queue.length === 0) return

    log.debug('Flushing %s metrics via %s', queue.length, this._httpOptions ? 'HTTP' : 'UDP')

    state.queue = []

    if (this._httpOptions) {
      this._sendHttp(queue, telemetry)
    } else {
      this._sendUdp(queue, telemetry)
    }
  }

  /**
   * Send self-telemetry metrics to the agent and reset the counters
   *
   * @memberof DogStatsDClient
   */
  sendTelemetry () {
    if (!this.#telemetryEnabled) return

    // Snapshot for async I/O
    const snapshot = {
      metrics: this.#metricsSent,
      metricsByType: this.#metricsByType,
      bytesSent: this.#bytesSent,
      bytesDropped: this.#bytesDropped,
      packetsSent: this.#packetsSent,
      packetsDropped: this.#packetsDropped,
    }

    this.#metricsSent = 0
    this.#metricsByType = {
      [TYPE_COUNTER]: 0,
      [TYPE_GAUGE]: 0,
      [TYPE_DISTRIBUTION]: 0,
      [TYPE_HISTOGRAM]: 0,
    }
    this.#bytesSent = 0
    this.#bytesDropped = 0
    this.#packetsSent = 0
    this.#packetsDropped = 0

    this._add('datadog.dogstatsd.client.metrics', snapshot.metrics, TYPE_COUNTER, [], true)
    for (const [type, value] of Object.entries(snapshot.metricsByType)) {
      const label = TYPE_LABEL[type]
      this._add('datadog.dogstatsd.client.metrics_by_type', value, TYPE_COUNTER, [`metrics_type:${label}`], true)
    }
    this._add('datadog.dogstatsd.client.bytes_sent', snapshot.bytesSent, TYPE_COUNTER, [], true)
    this._add('datadog.dogstatsd.client.bytes_dropped', snapshot.bytesDropped, TYPE_COUNTER, [], true)
    this._add('datadog.dogstatsd.client.packets_sent', snapshot.packetsSent, TYPE_COUNTER, [], true)
    this._add('datadog.dogstatsd.client.packets_dropped', snapshot.packetsDropped, TYPE_COUNTER, [], true)

    this.flush(true)
  }

  /**
   * Update self-telemetry counters.
   *
   * @param {string} type - The type of metric to record
   * @memberof DogStatsDClient
   */
  recordMetric (type) {
    if (!this.#telemetryEnabled) return

    this.#metricsSent++
    this.#metricsByType[type]++
  }

  /**
   * Send metrics to the agent via HTTP
   *
   * @param {Buffer[]} queue - The metrics to send
   * @param {boolean} [telemetry] - Whether the payload is self-telemetry or not
   * @memberof DogStatsDClient
   */
  _sendHttp (queue, telemetry = false) {
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
        this._sendUdp(queue, telemetry)
      } else if (this.#telemetryEnabled && !telemetry) {
        this.#bytesSent += buffer.length
        this.#packetsSent++
      }
    })
  }

  /**
   * Send metrics to the agent via UDP
   *
   * @param {Buffer[]} queue - The metrics to send
   * @param {boolean} [telemetry] - Whether the payload is self-telemetry or not
   * @memberof DogStatsDClient
   */
  _sendUdp (queue, telemetry = false) {
    if (this._family === 0) {
      this.#lookup(this._host, (err, address, family) => {
        if (err) {
          if (this.#telemetryEnabled && !telemetry) {
            const bytes = queue.reduce((sum, buf) => sum + buf.length, 0)
            this.#bytesDropped += bytes
            this.#packetsDropped += queue.length
          }
          return log.error('DogStatsDClient: Host not found', err)
        }
        this._sendUdpFromQueue(queue, address, family, telemetry)
      })
    } else {
      this._sendUdpFromQueue(queue, this._host, this._family, telemetry)
    }
  }

  /**
   * Send metrics to the agent via UDP from queue
   *
   * @param {Buffer[]} queue - The metrics to send
   * @param {string} address - The address to send the metrics to
   * @param {number} family - The family of the address
   * @param {boolean} [telemetry] - Whether the payload is self-telemetry or not
   * @memberof DogStatsDClient
   */
  _sendUdpFromQueue (queue, address, family, telemetry = false) {
    const socket = family === 6 ? this._udp6 : this._udp4

    for (const buffer of queue) {
      log.debug('Sending to DogStatsD: %s', buffer)
      socket.send(buffer, 0, buffer.length, this._port, address, (err) => {
        if (err) {
          if (this.#telemetryEnabled && !telemetry) {
            this.#bytesDropped += buffer.length
            this.#packetsDropped++
          }
          log.error('DogStatsDClient: UDP error', err)
        } else if (this.#telemetryEnabled && !telemetry) {
          this.#bytesSent += buffer.length
          this.#packetsSent++
        }
      })
    }
  }

  /**
   * Add a metric to the queue
   *
   * @param {string} stat - The metric name
   * @param {number} value - The metric value
   * @param {string} type - The metric type
   * @param {string[]} tags - The metric tags
   * @param {boolean} [telemetry] - Whether the metric is self-telemetry or not
   * @memberof DogStatsDClient
   */
  _add (stat, value, type, tags, telemetry = false) {
    let message = `${stat}:${value}|${type}`

    if (tags?.length) {
      message += this.#tagsPrefix
        ? `${this.#tagsPrefix},${tags.join(',')}`
        : `|#${tags.join(',')}`
    } else {
      message += this.#tagsPrefix
    }

    if (entityId) {
      message += `|c:${entityId}`
    }

    this._write(`${message}\n`, telemetry)
  }

  /**
   * Write a message to the queue
   *
   * @param {string} message - The message to write
   * @param {boolean} [telemetry] - Whether the message is self-telemetry or not
   * @memberof DogStatsDClient
   */
  _write (message, telemetry = false) {
    const offset = Buffer.byteLength(message)
    const state = telemetry ? this.#telemetry : this.#metrics
    if (state.offset + offset > MAX_BUFFER_SIZE) {
      this._enqueue(telemetry)
    }
    state.offset += offset
    state.buffer += message
  }

  /**
   * Enqueue a message to the queue
   *
   * @param {boolean} [telemetry] - Whether the message is self-telemetry or not
   * @memberof DogStatsDClient
   */
  _enqueue (telemetry = false) {
    const state = telemetry ? this.#telemetry : this.#metrics
    if (state.offset > 0) {
      state.queue.push(Buffer.from(state.buffer))
      state.buffer = ''
      state.offset = 0
    }
  }

  _socket (type) {
    const socket = dgram.createSocket(type)

    socket.on('error', () => {})
    socket.unref?.()

    return socket
  }

  /**
   * @param {import('./config/config-base')} config - Tracer configuration
   */
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
      lookup: config.lookup,
    }

    if (config.url || config.port) {
      clientConfig.metricsProxyUrl = getAgentUrl(config)
    }

    return clientConfig
  }
}

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
    this._client.sendTelemetry()
  }

  reset () {
    this._counters = new Map()
    this._gauges = new Map()
    this._histograms = new Map()
  }

  // TODO: Aggregate with a histogram and send the buckets to the client.
  distribution (name, value, tags) {
    this._client.distribution(name, value, tags)
    this._client.recordMetric(TYPE_DISTRIBUTION)
  }

  boolean (name, value, tags) {
    this.gauge(name, value ? 1 : 0, tags)
  }

  histogram (name, value, tags) {
    const node = this._ensureTree(this._histograms, name, tags, null)

    if (!node.value) {
      node.value = new Histogram()
    }

    node.value.record(value)
    this._client.recordMetric(TYPE_HISTOGRAM)
  }

  count (name, count, tags = [], monotonic = true) {
    if (typeof tags === 'boolean') {
      monotonic = tags
      tags = []
    }

    const container = monotonic ? this._counters : this._gauges
    const node = this._ensureTree(container, name, tags, 0)

    node.value += count
    this._client.recordMetric(TYPE_COUNTER)
  }

  gauge (name, value, tags) {
    const node = this._ensureTree(this._gauges, name, tags, 0)

    node.value = value
    this._client.recordMetric(TYPE_GAUGE)
  }

  increment (name, count = 1, tags) {
    this.count(name, count, tags)
  }

  decrement (name, count = 1, tags) {
    this.count(name, -count, tags)
  }

  _captureGauges () {
    this._captureTree(this._gauges, (node, name, tags) => {
      this._client.gauge(name, node.value, tags)
    })

    this._gauges.clear()
  }

  _captureCounters () {
    this._captureTree(this._counters, (node, name, tags) => {
      this._client.increment(name, node.value, tags)
    })

    this._counters.clear()
  }

  _captureHistograms () {
    this._captureTree(this._histograms, (node, name, tags) => {
      const stats = node.value

      this._client.gauge(`${name}.min`, stats.min, tags)
      this._client.gauge(`${name}.max`, stats.max, tags)
      this._client.increment(`${name}.sum`, stats.sum, tags)
      this._client.increment(`${name}.total`, stats.sum, tags)
      this._client.gauge(`${name}.avg`, stats.avg, tags)
      this._client.increment(`${name}.count`, stats.count, tags)
      this._client.gauge(`${name}.median`, stats.median, tags)
      this._client.gauge(`${name}.95percentile`, stats.p95, tags)
    })

    this._histograms.clear()
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
    this.#client = new MetricsAggregationClient(new DogStatsDClient({ ...clientConfig, telemetry: true }))

    const flush = this.flush.bind(this)

    // TODO(bengl) this magic number should be configurable
    setInterval(flush, 10 * 1000).unref?.()

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
