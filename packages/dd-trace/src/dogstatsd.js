'use strict'

const dgram = require('dgram')
const isIP = require('net').isIP
const { performance } = require('node:perf_hooks')

const { channel } = require('dc-polyfill')

const tracerVersion = require('../../../package.json').version
const { storage } = require('../../datadog-core')
const request = require('./exporters/common/request')
const log = require('./log')
const Histogram = require('./histogram')
const { entityId } = require('./exporters/common/docker')
const { registerTelemetryFlusher } = require('./flush')
const { createServerlessDeliveryTracker } = require('./serverless')

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
 * @property {number} submissions
 * @property {number|Histogram|null} value
 */

/**
 * @callback CaptureMetric
 * @param {MetricNode} node
 * @param {string} name
 * @param {string[]} tags
 * @returns {void}
 */

const identityRefreshChannel = channel('datadog:identity:refresh')

/**
 * @import { DogStatsD } from "../../../index.d.ts"
 * @implements {DogStatsD}
 */
class DogStatsDClient {
  #family
  #host
  #httpOptions
  #identityRefreshGeneration
  #lookup
  #metrics = { message: '', offset: 0, queue: [] }
  #port
  #serverlessDeliveryTracker
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
    this.#serverlessDeliveryTracker = createServerlessDeliveryTracker()

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
    }

    this.#updateTagPrefixes(options.tags.length ? `|#${options.tags.join(',')}` : '')

    this.#udp4 = this._socket('udp4')
    this.#udp6 = this._socket('udp6')
  }

  /**
   * Recomputes the cached tags and tag-prefix (mirrors the constructor) after a `config.tags`
   * change, e.g. a MicroVM clone resume.
   *
   * This is only ever called on identity refresh, so buffered lines and pending client telemetry
   * always describe pre-snapshot activity and must always be dropped - not just when the
   * serialized tag prefix happens to change. A clone resume with runtime-id tagging disabled and
   * Remote Config absent produces an identical prefix across clones, which would otherwise skip
   * the reset entirely.
   *
   * @param {string[]} tags - DogStatsD-formatted tags (e.g. `['key:value']`)
   * @returns {void}
   */
  updateTags (tags) {
    // Identity refresh is published only when a MicroVM clone starts. Invalidate detached buffers
    // that may contain the previous runtime ID; the generation stays undefined in normal operation.
    this.#identityRefreshGeneration = (this.#identityRefreshGeneration ?? 0) + 1

    const tagsPrefix = tags.length ? `|#${tags.join(',')}` : ''
    if (tagsPrefix !== this.#tagsPrefix) {
      this.#updateTagPrefixes(tagsPrefix)
    }

    this.#metrics.queue = []
    this.#metrics.message = ''
    this.#metrics.offset = 0

    // Telemetry describes the client's own transport activity (bytes/packets sent or dropped,
    // metrics counted so far), which is just as pre-snapshot as the buffered lines above - so it
    // gets the same treatment: dropped and zeroed rather than reported for the refreshed identity.
    const telemetry = this.telemetry
    if (telemetry) {
      telemetry.payload.queue = []
      telemetry.payload.message = ''
      telemetry.payload.offset = 0
      telemetry.bytesSent = 0
      telemetry.bytesDropped = 0
      telemetry.packetsSent = 0
      telemetry.packetsDropped = 0
      telemetry.nextFlush = performance.now() + TELEMETRY_INTERVAL
      for (let index = 0; index < TYPE_LABELS.length; index++) {
        telemetry.aggregatedContextsByType[index] = 0
        telemetry.metricsByType[index] = 0
      }
    }
  }

  /**
   * Updates the prefixes used for application metrics and client telemetry.
   * @param {string} tagsPrefix - Serialized global DogStatsD tags
   */
  #updateTagPrefixes (tagsPrefix) {
    this.#tagsPrefix = tagsPrefix

    if (!this.telemetry) return

    const separator = tagsPrefix ? ',' : '|#'
    const prefix = `${tagsPrefix}${separator}client:nodejs,client_version:${tracerVersion},client_transport:`
    this.#telemetryHttpTagsPrefix = `${prefix}http`
    this.#telemetryUdpTagsPrefix = `${prefix}udp`
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
   * @param {boolean|(() => void)} [forceTelemetry] - Whether to ignore the telemetry interval, or completion callback
   * @param {() => void} [done] - Called after serverless deliveries complete
   * @returns {void}
   */
  flush (forceTelemetry = false, done) {
    if (typeof forceTelemetry === 'function') {
      done = forceTelemetry
      forceTelemetry = false
    }

    let complete
    let track
    if (done && !this.#serverlessDeliveryTracker) {
      let pending = 1
      complete = () => {
        if (--pending === 0) done()
      }
      track = send => {
        pending++
        send(complete)
      }
    }

    this.#flush(this.#metrics, true, track)
    if (this.telemetry) this.#flushTelemetry(forceTelemetry, track)

    if (this.#serverlessDeliveryTracker) return this.#serverlessDeliveryTracker.waitForIdle(done)
    complete?.()
  }

  /**
   * @param {boolean} force - Whether to ignore the telemetry interval
   * @param {((send: (done?: () => void) => void) => void)} [track] - Tracks a non-serverless delivery
   * @returns {void}
   */
  #flushTelemetry (force, track) {
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

    this.#flush(telemetry.payload, false, track)
  }

  /**
   * @param {DogStatsDBufferState} state - Payload state to flush
   * @param {boolean} recordTelemetry - Whether to record the transport outcome
   * @param {((send: (done?: () => void) => void) => void)} [track] - Tracks a non-serverless delivery
   * @returns {void}
   */
  #flush (state, recordTelemetry, track) {
    const queue = this._enqueue(state)

    if (queue.length === 0) return

    log.debug('Flushing %s metrics via %s', queue.length, this.#httpOptions ? 'HTTP' : 'UDP')

    state.queue = []
    const identityRefreshGeneration = this.#identityRefreshGeneration

    const send = complete => {
      if (!this.#isCurrentIdentity(identityRefreshGeneration)) {
        complete?.()
        return
      }

      if (this.#httpOptions) this._sendHttp(queue, recordTelemetry, complete, identityRefreshGeneration)
      else this._sendUdp(queue, recordTelemetry, complete, identityRefreshGeneration)
    }

    if (this.#serverlessDeliveryTracker) return this.#serverlessDeliveryTracker.track(send)
    if (track) return track(send)
    send()
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
   * @param {() => void} [done] - Called after delivery completes
   * @param {number} [identityRefreshGeneration] - Generation captured before detaching the queue
   * @returns {void}
   * @memberof DogStatsDClient
   */
  _sendHttp (queue, recordTelemetry, done, identityRefreshGeneration) {
    if (!this.#isCurrentIdentity(identityRefreshGeneration)) {
      done?.()
      return
    }

    const buffer = Buffer.concat(queue)
    request(buffer, this.#httpOptions, (error, _result, _statusCode, _headers, dropped) => {
      if (!this.#isCurrentIdentity(identityRefreshGeneration)) {
        done?.()
        return
      }

      if (dropped) {
        if (recordTelemetry && this.telemetry) {
          this.#recordDropped(buffer.length)
        }
        done?.()
      } else if (error) {
        log.error('DogStatsDClient: HTTP error from agent: %s', error.message, error)
        if (error.status === 404) {
          // Inside this if-block, we have connectivity to the agent, but
          // we're not getting a 200 from the proxy endpoint. If it's a 404,
          // then we know we'll never have the endpoint, so just clear out the
          // options. Either way, we can give UDP a try.
          this.#httpOptions = undefined
        }
        this._sendUdp(queue, recordTelemetry, done, identityRefreshGeneration)
      } else {
        if (recordTelemetry && this.telemetry) this.#recordSent(buffer.length)
        done?.()
      }
    })
  }

  /**
   * Send metrics to the agent via UDP
   *
   * @param {Buffer[]} queue - The metrics to send
   * @param {boolean} recordTelemetry - Whether to record the transport outcome
   * @param {() => void} [done] - Called after delivery completes
   * @param {number} [identityRefreshGeneration] - Generation captured before detaching the queue
   * @returns {void}
   * @memberof DogStatsDClient
   */
  _sendUdp (queue, recordTelemetry, done, identityRefreshGeneration) {
    if (!this.#isCurrentIdentity(identityRefreshGeneration)) {
      done?.()
      return
    }

    // dgram resolves the local address via the instrumented dns.lookup when it
    // binds on first send; the noop store keeps that self-traffic off the trace.
    legacyStorage.run({ noop: true }, () => {
      if (this.#family === 0) {
        this.#lookup(this.#host, (error, address, family) => {
          if (!this.#isCurrentIdentity(identityRefreshGeneration)) {
            done?.()
            return
          }

          if (error) {
            if (recordTelemetry && this.telemetry) {
              let bytes = 0
              for (const buffer of queue) {
                bytes += buffer.length
              }
              this.#recordDropped(bytes, queue.length)
            }
            log.error('DogStatsDClient: Host not found', error)
            return done?.()
          }
          this._sendUdpFromQueue(queue, address, family, recordTelemetry, done, identityRefreshGeneration)
        })
      } else {
        this._sendUdpFromQueue(
          queue, this.#host, this.#family, recordTelemetry, done, identityRefreshGeneration
        )
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
   * @param {() => void} [done] - Called after every packet completes
   * @param {number} [identityRefreshGeneration] - Generation captured before detaching the queue
   * @returns {void}
   * @memberof DogStatsDClient
   */
  _sendUdpFromQueue (queue, address, family, recordTelemetry, done, identityRefreshGeneration) {
    const socket = family === 6 ? this.#udp6 : this.#udp4
    let pending = queue.length
    const complete = () => {
      if (--pending === 0) done?.()
    }

    for (const buffer of queue) {
      if (!this.#isCurrentIdentity(identityRefreshGeneration)) {
        complete()
        continue
      }

      log.debug('Sending to DogStatsD: %s', buffer)

      if (!this.telemetry && !done) {
        socket.send(buffer, 0, buffer.length, this.#port, address)
        continue
      }

      try {
        socket.send(buffer, 0, buffer.length, this.#port, address, (error) => {
          if (!this.#isCurrentIdentity(identityRefreshGeneration)) {
            complete()
            return
          } else if (error) {
            if (recordTelemetry && this.telemetry) {
              this.#recordDropped(buffer.length)
            }
            log.error('DogStatsDClient: UDP error', error)
          } else if (recordTelemetry && this.telemetry) {
            this.#recordSent(buffer.length)
          }
          complete()
        })
      } catch (error) {
        log.error('DogStatsDClient: UDP error sending metrics', error)
        complete()
      }
    }
  }

  /**
   * @param {number|undefined} identityRefreshGeneration - Generation captured before detaching the queue
   * @returns {boolean} Whether the detached queue still belongs to the current identity
   */
  #isCurrentIdentity (identityRefreshGeneration) {
    return identityRefreshGeneration === this.#identityRefreshGeneration
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
  #metricsByType

  /** @type {DogStatsDTelemetryState|undefined} */
  #telemetry

  /**
   * @param {DogStatsDClient} client - DogStatsD transport client
   */
  constructor (client) {
    this._client = client
    this.#telemetry = client.telemetry
    this.#metricsByType = this.#telemetry?.metricsByType ?? [0, 0, 0, 0]

    this.reset()
  }

  /**
   * Recomputes the wrapped client's cached tags (e.g. after a MicroVM clone resume). Pending
   * counters/gauges/histograms were aggregated under the old identity, so they're always reset
   * along with the client's buffered lines, regardless of whether the serialized tags changed.
   * @param {string[]} tags - DogStatsD-formatted tags (e.g. `['key:value']`)
   */
  updateTags (tags) {
    this._client.updateTags(tags)
    this.reset()
  }

  /**
   * @param {boolean|(() => void)} [forceTelemetry] - Whether to ignore the telemetry interval, or completion callback
   * @param {() => void} [done] - Called after serverless deliveries complete
   * @returns {void}
   */
  flush (forceTelemetry = false, done) {
    if (typeof forceTelemetry === 'function') {
      done = forceTelemetry
      forceTelemetry = false
    }

    const counters = this._captureCounters()
    const gauges = this._captureGauges()
    const histograms = this._captureHistograms()
    const telemetry = this.#telemetry

    if (telemetry) {
      telemetry.aggregatedContextsByType[TYPE_COUNTER_INDEX] += counters
      telemetry.aggregatedContextsByType[TYPE_GAUGE_INDEX] += gauges
      telemetry.aggregatedContextsByType[TYPE_HISTOGRAM_INDEX] += histograms
    }

    if (forceTelemetry) this._client.flush(true, done)
    else this._client.flush(done)
  }

  reset () {
    this._counters = new Map()
    this._gauges = new Map()
    this._histograms = new Map()
  }

  // TODO: Aggregate with a histogram and send the buckets to the client.
  distribution (name, value, tags) {
    this._client.distribution(name, value, tags)
    this.#metricsByType[TYPE_DISTRIBUTION_INDEX]++
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
  }

  count (name, count, tags = [], monotonic = true) {
    if (typeof tags === 'boolean') {
      monotonic = tags
      tags = []
    }

    const container = monotonic ? this._counters : this._gauges
    const node = this._ensureTree(container, name, tags, 0)

    node.value += count
  }

  gauge (name, value, tags) {
    const node = this._ensureTree(this._gauges, name, tags, 0)

    node.value = value
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
    let metrics = 0
    const contexts = this._captureTree(this._gauges, (node, name, tags) => {
      metrics += node.submissions
      this._client.gauge(name, node.value, tags)
    })

    this.#metricsByType[TYPE_GAUGE_INDEX] += metrics
    this._gauges.clear()

    return contexts
  }

  /**
   * @returns {number} Number of counter contexts flushed
   */
  _captureCounters () {
    let metrics = 0
    const contexts = this._captureTree(this._counters, (node, name, tags) => {
      metrics += node.submissions
      this._client.increment(name, node.value, tags)
    })

    this.#metricsByType[TYPE_COUNTER_INDEX] += metrics
    this._counters.clear()

    return contexts
  }

  /**
   * @returns {number} Number of histogram contexts flushed
   */
  _captureHistograms () {
    let metrics = 0
    const contexts = this._captureTree(this._histograms, (node, name, tags) => {
      metrics += node.submissions
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

    this.#metricsByType[TYPE_HISTOGRAM_INDEX] += metrics
    this._histograms.clear()

    return contexts
  }

  /**
   * @param {Map<string, MetricNode>} tree - Metric context tree
   * @param {CaptureMetric} fn - Called for every context with submissions
   * @returns {number} Number of contexts with submissions
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
   * @param {CaptureMetric} fn - Called for every context with submissions
   * @returns {number} Number of contexts with submissions
   */
  _captureNode (node, name, tags, fn) {
    let contexts = 0

    if (node.submissions !== 0) {
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

    node.submissions++

    return node
  }

  _ensureNode (container, key, value) {
    let node = container.get(key)

    if (!node) {
      node = { nodes: new Map(), submissions: 0, value }

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

    // CustomMetrics has process-lifetime flush handlers and no stop hook, so this shares that lifetime.
    identityRefreshChannel.subscribe(() => {
      this.#client.updateTags(DogStatsDClient.generateClientConfig(config).tags)
    })

    const flush = this.flush.bind(this)

    // TODO(bengl) this magic number should be configurable
    setInterval(flush, 10 * 1000).unref?.()

    globalThis[Symbol.for('dd-trace')].beforeExitHandlers.add(() => this.#client.flush(true))
    registerTelemetryFlusher(done => this.flush(done))
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

  flush (done) {
    return this.#client.flush(false, done)
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
