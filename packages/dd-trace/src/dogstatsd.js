'use strict'

const dgram = require('dgram')
const isIP = require('net').isIP
const { performance } = require('node:perf_hooks')

const tracerVersion = require('../../../package.json').version
const { storage } = require('../../datadog-core')
const request = require('./exporters/common/request')
const log = require('./log')
const Histogram = require('./histogram')
const { entityId } = require('./exporters/common/docker')

const legacyStorage = storage('legacy')

const MAX_BUFFER_SIZE = 1024 // limit from the agent
const TELEMETRY_INTERVAL = 10_000

const TYPE_COUNTER = 'c'
const TYPE_GAUGE = 'g'
const TYPE_DISTRIBUTION = 'd'
const TYPE_HISTOGRAM = 'h'

const TYPE_COUNTER_INDEX = 0
const TYPE_GAUGE_INDEX = 1
const TYPE_DISTRIBUTION_INDEX = 2
const TYPE_HISTOGRAM_INDEX = 3
const TYPE_LABELS = ['count', 'gauge', 'distribution', 'histogram']

/**
 * @typedef {'c'|'g'|'d'|'h'} MetricType
 */

/**
 * @typedef {object} DogStatsDBufferState
 * @property {string} message
 * @property {number} offset
 * @property {Buffer[]} queue
 */

/**
 * @typedef {object} DogStatsDClientOptions
 * @property {string} host
 * @property {number} port
 * @property {string[]} tags
 * @property {typeof import('node:dns').lookup} lookup
 * @property {URL|string} [metricsProxyUrl]
 */

/**
 * @typedef {object} DogStatsDTelemetryState
 * @property {number[]} aggregatedContextsByType
 * @property {number} bytesDropped
 * @property {number} bytesSent
 * @property {number[]} metricsByType
 * @property {number} nextFlush
 * @property {number} packetsDropped
 * @property {number} packetsSent
 * @property {DogStatsDBufferState} payload
 */

/**
 * @typedef {object} MetricNode
 * @property {Map<string, MetricNode>} nodes
 * @property {boolean} touched
 * @property {number|Histogram|null} value
 */

/**
 * @callback CaptureMetric
 * @param {MetricNode} node
 * @param {string} name
 * @param {string[]} tags
 * @returns {void}
 */

/**
 * @import { DogStatsD } from "../../../index.d.ts"
 * @implements {DogStatsD}
 */
class DogStatsDClient {
  #family
  #host
  #httpOptions
  #lookup
  #metrics = { message: '', offset: 0, queue: [] }
  #port
  #tagsPrefix
  #telemetryHttpTagsPrefix
  #telemetryUdpTagsPrefix
  #udp4
  #udp6

  /** @type {DogStatsDTelemetryState|undefined} */
  telemetry

  /**
   * @param {DogStatsDClientOptions} options - DogStatsD transport options
   * @param {boolean} [telemetryEnabled] - Whether to collect client telemetry
   */
  constructor (options, telemetryEnabled = false) {
    this.#lookup = options.lookup
    if (options.metricsProxyUrl) {
      this.#httpOptions = {
        method: 'POST',
        retry: false,
        url: options.metricsProxyUrl.toString(),
        path: '/dogstatsd/v2/proxy',
      }
    }

    this.#family = isIP(options.host)
    this.#host = options.host
    this.#port = options.port
    this.#tagsPrefix = options.tags?.length ? `|#${options.tags.join(',')}` : ''

    if (telemetryEnabled) {
      this.telemetry = {
        aggregatedContextsByType: [0, 0, 0, 0],
        bytesDropped: 0,
        bytesSent: 0,
        metricsByType: [0, 0, 0, 0],
        nextFlush: performance.now() + TELEMETRY_INTERVAL,
        packetsDropped: 0,
        packetsSent: 0,
        payload: { message: '', offset: 0, queue: [] },
      }

      const separator = this.#tagsPrefix ? ',' : '|#'
      const prefix = `${this.#tagsPrefix}${separator}client:nodejs,client_version:${tracerVersion},client_transport:`
      this.#telemetryHttpTagsPrefix = `${prefix}http`
      this.#telemetryUdpTagsPrefix = `${prefix}udp`
    }

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

  /**
   * @param {boolean} [forceTelemetry] - Whether to ignore the telemetry interval
   * @returns {void}
   */
  flush (forceTelemetry = false) {
    this.#flush(this.#metrics, true)
    if (this.telemetry) this.#flushTelemetry(forceTelemetry)
  }

  /**
   * @param {boolean} force - Whether to ignore the telemetry interval
   * @returns {void}
   */
  #flushTelemetry (force) {
    const telemetry = this.telemetry

    const now = performance.now()

    if (!force && now < telemetry.nextFlush) return

    telemetry.nextFlush = now + TELEMETRY_INTERVAL

    let aggregatedContexts = 0
    let metrics = 0
    for (let index = 0; index < TYPE_LABELS.length; index++) {
      aggregatedContexts += telemetry.aggregatedContextsByType[index]
      metrics += telemetry.metricsByType[index]
    }

    this.#addTelemetry('datadog.dogstatsd.client.metrics', metrics)
    this.#addTelemetry('datadog.dogstatsd.client.aggregated_context', aggregatedContexts)
    for (let index = 0; index < TYPE_LABELS.length; index++) {
      this.#addTelemetry(
        'datadog.dogstatsd.client.metrics_by_type',
        telemetry.metricsByType[index],
        TYPE_LABELS[index]
      )
      this.#addTelemetry(
        'datadog.dogstatsd.client.aggregated_context_by_type',
        telemetry.aggregatedContextsByType[index],
        TYPE_LABELS[index]
      )
    }
    this.#addTelemetry('datadog.dogstatsd.client.bytes_sent', telemetry.bytesSent)
    this.#addTelemetry('datadog.dogstatsd.client.bytes_dropped', telemetry.bytesDropped)
    this.#addTelemetry('datadog.dogstatsd.client.packets_sent', telemetry.packetsSent)
    this.#addTelemetry('datadog.dogstatsd.client.packets_dropped', telemetry.packetsDropped)

    telemetry.bytesSent = 0
    telemetry.bytesDropped = 0
    telemetry.packetsSent = 0
    telemetry.packetsDropped = 0
    for (let index = 0; index < TYPE_LABELS.length; index++) {
      telemetry.aggregatedContextsByType[index] = 0
      telemetry.metricsByType[index] = 0
    }

    this.#flush(telemetry.payload, false)
  }

  /**
   * @param {DogStatsDBufferState} state - Payload state to flush
   * @param {boolean} recordTelemetry - Whether to record the transport outcome
   * @returns {void}
   */
  #flush (state, recordTelemetry) {
    const queue = this._enqueue(state)

    if (queue.length === 0) return

    log.debug('Flushing %s metrics via %s', queue.length, this.#httpOptions ? 'HTTP' : 'UDP')

    state.queue = []

    if (this.#httpOptions) {
      this._sendHttp(queue, recordTelemetry)
    } else {
      this._sendUdp(queue, recordTelemetry)
    }
  }

  /**
   * @param {number} bytes - Number of bytes sent
   * @returns {void}
   */
  #recordSent (bytes) {
    const telemetry = this.telemetry

    telemetry.bytesSent += bytes
    telemetry.packetsSent++
  }

  /**
   * @param {number} bytes - Number of bytes dropped
   * @param {number} [packets] - Number of packets dropped
   * @returns {void}
   */
  #recordDropped (bytes, packets = 1) {
    const telemetry = this.telemetry

    telemetry.bytesDropped += bytes
    telemetry.packetsDropped += packets
  }

  /**
   * Send metrics to the agent via HTTP
   *
   * @param {Buffer[]} queue - The metrics to send
   * @param {boolean} recordTelemetry - Whether to record the transport outcome
   * @returns {void}
   * @memberof DogStatsDClient
   */
  _sendHttp (queue, recordTelemetry) {
    const buffer = Buffer.concat(queue)
    request(buffer, this.#httpOptions, (error, _result, _statusCode, _headers, dropped) => {
      if (dropped) {
        if (recordTelemetry && this.telemetry) {
          this.#recordDropped(buffer.length)
        }
      } else if (error) {
        log.error('DogStatsDClient: HTTP error from agent: %s', error.message, error)
        if (error.status === 404) {
          // Inside this if-block, we have connectivity to the agent, but
          // we're not getting a 200 from the proxy endpoint. If it's a 404,
          // then we know we'll never have the endpoint, so just clear out the
          // options. Either way, we can give UDP a try.
          this.#httpOptions = undefined
        }
        this._sendUdp(queue, recordTelemetry)
      } else if (recordTelemetry && this.telemetry) {
        this.#recordSent(buffer.length)
      }
    })
  }

  /**
   * Send metrics to the agent via UDP
   *
   * @param {Buffer[]} queue - The metrics to send
   * @param {boolean} recordTelemetry - Whether to record the transport outcome
   * @returns {void}
   * @memberof DogStatsDClient
   */
  _sendUdp (queue, recordTelemetry) {
    // dgram resolves the local address via the instrumented dns.lookup when it
    // binds on first send; the noop store keeps that self-traffic off the trace.
    legacyStorage.run({ noop: true }, () => {
      if (this.#family === 0) {
        this.#lookup(this.#host, (error, address, family) => {
          if (error) {
            if (recordTelemetry && this.telemetry) {
              let bytes = 0
              for (const buffer of queue) {
                bytes += buffer.length
              }
              this.#recordDropped(bytes, queue.length)
            }
            return log.error('DogStatsDClient: Host not found', error)
          }
          this._sendUdpFromQueue(queue, address, family, recordTelemetry)
        })
      } else {
        this._sendUdpFromQueue(queue, this.#host, this.#family, recordTelemetry)
      }
    })
  }

  /**
   * Send metrics to the agent via UDP from queue
   *
   * @param {Buffer[]} queue - The metrics to send
   * @param {string} address - The address to send the metrics to
   * @param {number} family - The family of the address
   * @param {boolean} recordTelemetry - Whether to record the transport outcome
   * @returns {void}
   * @memberof DogStatsDClient
   */
  _sendUdpFromQueue (queue, address, family, recordTelemetry) {
    const socket = family === 6 ? this.#udp6 : this.#udp4

    for (const buffer of queue) {
      log.debug('Sending to DogStatsD: %s', buffer)

      if (!this.telemetry) {
        socket.send(buffer, 0, buffer.length, this.#port, address)
        continue
      }

      socket.send(buffer, 0, buffer.length, this.#port, address, (error) => {
        if (error) {
          if (recordTelemetry) {
            this.#recordDropped(buffer.length)
          }
          log.error('DogStatsDClient: UDP error', error)
        } else if (recordTelemetry) {
          this.#recordSent(buffer.length)
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
   * @param {string} [tagsPrefix] - Serialized global tags
   * @param {DogStatsDBufferState} [state] - Payload state receiving the metric
   * @returns {void}
   * @memberof DogStatsDClient
   */
  _add (stat, value, type, tags, tagsPrefix = this.#tagsPrefix, state = this.#metrics) {
    let message = `${stat}:${value}|${type}`

    if (tags?.length) {
      message += tagsPrefix
        ? `${tagsPrefix},${tags.join(',')}`
        : `|#${tags.join(',')}`
    } else {
      message += tagsPrefix
    }

    if (entityId) {
      message += `|c:${entityId}`
    }

    this._write(`${message}\n`, state)
  }

  /**
   * @param {string} stat - Telemetry metric name
   * @param {number} value - Telemetry metric value
   * @param {string} [typeLabel] - Submitted or aggregated metric type
   * @returns {void}
   */
  #addTelemetry (stat, value, typeLabel) {
    const tags = typeLabel === undefined ? undefined : [`metrics_type:${typeLabel}`]
    const tagsPrefix = this.#httpOptions ? this.#telemetryHttpTagsPrefix : this.#telemetryUdpTagsPrefix

    this._add(stat, value, TYPE_COUNTER, tags, tagsPrefix, this.telemetry.payload)
  }

  /**
   * Write a message to the queue
   *
   * @param {string} message - The message to write
   * @param {DogStatsDBufferState} [state] - Payload state receiving the message
   * @returns {void}
   * @memberof DogStatsDClient
   */
  _write (message, state = this.#metrics) {
    const offset = Buffer.byteLength(message)
    if (state.offset + offset > MAX_BUFFER_SIZE) {
      this._enqueue(state)
    }
    state.offset += offset
    state.message += message
  }

  /**
   * Enqueue a message to the queue
   *
   * @param {DogStatsDBufferState} [state] - Payload state to enqueue
   * @returns {Buffer[]} Queued payloads
   * @memberof DogStatsDClient
   */
  _enqueue (state = this.#metrics) {
    if (state.offset > 0) {
      state.queue.push(Buffer.from(state.message))
      state.message = ''
      state.offset = 0
    }

    return state.queue
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

    if (config.url) {
      clientConfig.metricsProxyUrl = config.url
    }

    return clientConfig
  }
}

/**
 * @param {DogStatsDClientOptions} options - DogStatsD transport options
 * @returns {MetricsAggregationClient} Aggregating client with shared telemetry
 */
function createMetricsAggregationClient (options) {
  const client = new DogStatsDClient(options, true)

  return new MetricsAggregationClient(client)
}

class MetricsAggregationClient {
  /** @type {DogStatsDTelemetryState|undefined} */
  #telemetry

  /**
   * @param {DogStatsDClient} client - DogStatsD transport client
   */
  constructor (client) {
    this._client = client
    this.#telemetry = client.telemetry

    this.reset()
  }

  /**
   * @param {boolean} [forceTelemetry] - Whether to ignore the telemetry interval
   * @returns {void}
   */
  flush (forceTelemetry = false) {
    const counters = this._captureCounters()
    const gauges = this._captureGauges()
    const histograms = this._captureHistograms()
    const telemetry = this.#telemetry

    if (telemetry) {
      telemetry.aggregatedContextsByType[TYPE_COUNTER_INDEX] += counters
      telemetry.aggregatedContextsByType[TYPE_GAUGE_INDEX] += gauges
      telemetry.aggregatedContextsByType[TYPE_HISTOGRAM_INDEX] += histograms
    }

    this._client.flush(forceTelemetry)
  }

  reset () {
    this._counters = new Map()
    this._gauges = new Map()
    this._histograms = new Map()
  }

  // TODO: Aggregate with a histogram and send the buckets to the client.
  distribution (name, value, tags) {
    this._client.distribution(name, value, tags)
    const telemetry = this.#telemetry

    if (telemetry) telemetry.metricsByType[TYPE_DISTRIBUTION_INDEX]++
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
    const telemetry = this.#telemetry

    if (telemetry) telemetry.metricsByType[TYPE_HISTOGRAM_INDEX]++
  }

  count (name, count, tags = [], monotonic = true) {
    if (typeof tags === 'boolean') {
      monotonic = tags
      tags = []
    }

    const container = monotonic ? this._counters : this._gauges
    const node = this._ensureTree(container, name, tags, 0)

    node.value += count
    const telemetry = this.#telemetry

    if (telemetry) telemetry.metricsByType[monotonic ? TYPE_COUNTER_INDEX : TYPE_GAUGE_INDEX]++
  }

  gauge (name, value, tags) {
    const node = this._ensureTree(this._gauges, name, tags, 0)

    node.value = value
    const telemetry = this.#telemetry

    if (telemetry) telemetry.metricsByType[TYPE_GAUGE_INDEX]++
  }

  increment (name, count = 1, tags) {
    this.count(name, count, tags)
  }

  decrement (name, count = 1, tags) {
    this.count(name, -count, tags)
  }

  /**
   * @returns {number} Number of gauge contexts flushed
   */
  _captureGauges () {
    const contexts = this._captureTree(this._gauges, (node, name, tags) => {
      this._client.gauge(name, node.value, tags)
    })

    this._gauges.clear()

    return contexts
  }

  /**
   * @returns {number} Number of counter contexts flushed
   */
  _captureCounters () {
    const contexts = this._captureTree(this._counters, (node, name, tags) => {
      this._client.increment(name, node.value, tags)
    })

    this._counters.clear()

    return contexts
  }

  /**
   * @returns {number} Number of histogram contexts flushed
   */
  _captureHistograms () {
    const contexts = this._captureTree(this._histograms, (node, name, tags) => {
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

    return contexts
  }

  /**
   * @param {Map<string, MetricNode>} tree - Metric context tree
   * @param {CaptureMetric} fn - Called for every touched context
   * @returns {number} Number of touched contexts
   */
  _captureTree (tree, fn) {
    let contexts = 0

    for (const [name, root] of tree) {
      contexts += this._captureNode(root, name, [], fn)
    }

    return contexts
  }

  /**
   * @param {MetricNode} node - Current metric context node
   * @param {string} name - Metric name
   * @param {string[]} tags - Current metric tags
   * @param {CaptureMetric} fn - Called for every touched context
   * @returns {number} Number of touched contexts
   */
  _captureNode (node, name, tags, fn) {
    let contexts = 0

    if (node.touched) {
      fn(node, name, tags)
      contexts++
    }

    for (const [tag, next] of node.nodes) {
      tags.push(tag)
      contexts += this._captureNode(next, name, tags, fn)
      tags.pop()
    }

    return contexts
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
    this.#client = createMetricsAggregationClient(clientConfig)

    const flush = this.flush.bind(this)

    // TODO(bengl) this magic number should be configurable
    setInterval(flush, 10 * 1000).unref?.()

    globalThis[Symbol.for('dd-trace')].beforeExitHandlers.add(() => this.#client.flush(true))
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
  createMetricsAggregationClient,
}
