'use strict'

const os = require('node:os')
const pkg = require('../../../package.json')

const { LogCollapsingLowestDenseDDSketch } = require('../../../vendor/dist/@datadog/sketches-js')
const {
  MEASURED,
  SPAN_KIND,
  HTTP_STATUS_CODE,
  HTTP_ENDPOINT,
  HTTP_ROUTE,
  HTTP_METHOD,
} = require('../../../ext/tags')
const { ORIGIN_KEY, TOP_LEVEL_KEY } = require('./constants')
const { version } = require('./pkg')
const processTags = require('./process-tags')

const { SpanStatsExporter } = require('./exporters/span-stats')

const {
  DEFAULT_SPAN_NAME,
  DEFAULT_SERVICE_NAME,
} = require('./encode/tags-processors')

// Trilean values for is_trace_root per Go reference implementation
const TRILEAN_NOT_SET = 0
const TRILEAN_TRUE = 1
const TRILEAN_FALSE = 2

// span.kind values that make a span eligible for stats
const SPAN_KIND_SERVER = 'server'
const SPAN_KIND_CLIENT = 'client'
const SPAN_KIND_PRODUCER = 'producer'
const SPAN_KIND_CONSUMER = 'consumer'
const ELIGIBLE_SPAN_KINDS = new Set([SPAN_KIND_SERVER, SPAN_KIND_CLIENT, SPAN_KIND_PRODUCER, SPAN_KIND_CONSUMER])

// span.kind values that support peer tags (client-side or message producers/consumers)
const PEER_TAG_SPAN_KINDS = new Set([SPAN_KIND_CLIENT, SPAN_KIND_PRODUCER, SPAN_KIND_CONSUMER])

// gRPC status code extraction keys, checked in order
const GRPC_STATUS_KEYS = [
  'rpc.grpc.status_code',
  'grpc.code',
  'rpc.grpc.status.code',
  'grpc.status.code',
]

// Default peer tags to extract per Go reference implementation
const DEFAULT_PEER_TAGS = [
  '_dd.base_service',
  'peer.hostname',
  'peer.service',
  'db.name',
  'db.instance',
  'db.system',
  'network.destination.name',
]

class SpanAggStats {
  constructor (aggKey) {
    this.aggKey = aggKey
    this.hits = 0
    this.topLevelHits = 0
    this.errors = 0
    this.duration = 0
    this.okDistribution = new LogCollapsingLowestDenseDDSketch()
    this.errorDistribution = new LogCollapsingLowestDenseDDSketch()
  }

  record (span) {
    const durationNs = span.duration
    this.hits++
    this.duration += durationNs

    if (span.metrics[TOP_LEVEL_KEY]) {
      this.topLevelHits++
    }

    if (span.error) {
      this.errors++
      this.errorDistribution.accept(durationNs)
    } else {
      this.okDistribution.accept(durationNs)
    }
  }

  toJSON () {
    const {
      name,
      service,
      resource,
      type,
      statusCode,
      synthetics,
      method,
      endpoint,
      spanKind,
      isTraceRoot,
      peerTags,
      grpcStatusCode,
    } = this.aggKey

    return {
      Name: name,
      Service: service,
      Resource: resource,
      Type: type,
      HTTPStatusCode: statusCode,
      Synthetics: synthetics,
      HTTPMethod: method,
      HTTPEndpoint: endpoint,
      SpanKind: spanKind,
      IsTraceRoot: isTraceRoot,
      PeerTags: peerTags,
      GRPCStatusCode: grpcStatusCode,
      Hits: this.hits,
      TopLevelHits: this.topLevelHits,
      Errors: this.errors,
      Duration: this.duration,
      OkSummary: this.okDistribution.toProto(), // TODO: custom proto encoding
      ErrorSummary: this.errorDistribution.toProto(), // TODO: custom proto encoding
    }
  }
}

class SpanAggKey {
  /**
   * @param {object} span - Formatted span object
   * @param {string[]} peerTagKeys - List of peer tag keys to extract
   */
  constructor (span, peerTagKeys) {
    this.name = span.name || DEFAULT_SPAN_NAME
    this.service = span.service || DEFAULT_SERVICE_NAME
    this.resource = span.resource || ''
    this.type = span.type || ''
    this.statusCode = span.meta[HTTP_STATUS_CODE] || 0
    this.synthetics = span.meta[ORIGIN_KEY] === 'synthetics'
    this.endpoint = span.meta[HTTP_ROUTE] || span.meta[HTTP_ENDPOINT] || ''
    this.method = span.meta[HTTP_METHOD] || ''

    // New dimensions
    const rawSpanKind = span.meta[SPAN_KIND] || ''
    this.spanKind = rawSpanKind

    // is_trace_root: Trilean - TRUE(1) if parentID==0, FALSE(2) otherwise, NOT_SET(0) if unknown
    this.isTraceRoot = getIsTraceRoot(span)

    // gRPC status code extraction (check multiple keys in order)
    this.grpcStatusCode = extractGrpcStatusCode(span)

    // peer tags: only for client/producer/consumer span kinds
    this.peerTags = extractPeerTags(span, rawSpanKind, peerTagKeys)
  }

  toString () {
    return [
      this.name,
      this.service,
      this.resource,
      this.type,
      this.statusCode,
      this.synthetics,
      this.method,
      this.endpoint,
      this.spanKind,
      this.isTraceRoot,
      this.peerTags.join('|'),
      this.grpcStatusCode,
    ].join(',')
  }
}

/**
 * Determines the is_trace_root trilean value for a span.
 * @param {object} span - Formatted span object
 * @returns {number} TRILEAN_TRUE(1) if parentID==0, TRILEAN_FALSE(2) otherwise
 */
function getIsTraceRoot (span) {
  const parentId = span.parent_id
  if (parentId === undefined || parentId === null) {
    return TRILEAN_TRUE
  }
  // parent_id can be a Buffer/ID object with toString, or a number
  const parentStr = (parentId !== null && typeof parentId === 'object') ? parentId.toString(10) : String(parentId)
  return parentStr === '0' ? TRILEAN_TRUE : TRILEAN_FALSE
}

/**
 * Extracts gRPC status code from span meta, checking multiple keys in order.
 * @param {object} span - Formatted span object
 * @returns {number} The gRPC status code, or 0 if not found
 */
function extractGrpcStatusCode (span) {
  for (const key of GRPC_STATUS_KEYS) {
    const value = span.meta[key] ?? span.metrics?.[key]
    if (value !== undefined && value !== null) {
      const code = Number(value)
      if (!Number.isNaN(code)) {
        return code
      }
    }
  }
  return 0
}

/**
 * Extracts peer tags from the span for client/producer/consumer span kinds.
 * @param {object} span - Formatted span object
 * @param {string} spanKind - The span kind value
 * @param {string[]} peerTagKeys - List of peer tag keys to extract
 * @returns {string[]} Sorted array of "key:value" peer tag strings
 */
function extractPeerTags (span, spanKind, peerTagKeys) {
  if (!PEER_TAG_SPAN_KINDS.has(spanKind) || !peerTagKeys?.length) {
    return []
  }

  const tags = []
  for (const key of peerTagKeys) {
    const value = span.meta[key] ?? span.metrics?.[key]
    if (value !== undefined && value !== null && value !== '') {
      tags.push(`${key}:${value}`)
    }
  }
  tags.sort()
  return tags
}

class SpanBuckets extends Map {
  /**
   * @param {object} span - Formatted span object
   * @param {string[]} peerTagKeys - List of peer tag keys to extract
   * @returns {SpanAggStats}
   */
  forSpan (span, peerTagKeys) {
    const aggKey = new SpanAggKey(span, peerTagKeys)
    const key = aggKey.toString()

    if (!this.has(key)) {
      this.set(key, new SpanAggStats(aggKey))
    }

    return this.get(key)
  }
}

class TimeBuckets extends Map {
  forTime (time) {
    if (!this.has(time)) {
      this.set(time, new SpanBuckets())
    }

    return this.get(time)
  }
}

class SpanStatsProcessor {
  constructor ({
    stats: {
      enabled = false,
      interval = 10,
    },
    hostname,
    port,
    url,
    env,
    tags,
    version,
  } = {}) {
    this.exporter = new SpanStatsExporter({
      hostname,
      port,
      tags,
      url,
    })
    this.interval = interval
    this.bucketSizeNs = interval * 1e9
    this.buckets = new TimeBuckets()
    this.hostname = os.hostname()
    this.enabled = enabled
    this.env = env
    this.tags = tags || {}
    this.sequence = 0
    this.version = version
    this.peerTagKeys = DEFAULT_PEER_TAGS

    if (this.enabled) {
      this.timer = setInterval(this.onInterval.bind(this), interval * 1e3)
      this.timer.unref()
    }
  }

  /**
   * Sets the peer tag keys to extract from spans, typically from agent /info config.
   * @param {string[]} keys - Array of peer tag keys
   */
  setPeerTagKeys (keys) {
    if (Array.isArray(keys) && keys.length > 0) {
      this.peerTagKeys = keys
    }
  }

  onInterval () {
    const serialized = this._serializeBuckets()
    if (!serialized) return

    this.exporter.export({
      Hostname: this.hostname,
      Env: this.env,
      Version: this.version || version,
      Stats: serialized,
      Lang: 'javascript',
      TracerVersion: pkg.version,
      RuntimeID: this.tags['runtime-id'],
      Sequence: ++this.sequence,
      ProcessTags: processTags.serialized,
    })
  }

  onSpanFinished (span) {
    if (!this.enabled) return
    if (!this._isEligible(span)) return

    const spanEndNs = span.startTime + span.duration
    const bucketTime = spanEndNs - (spanEndNs % this.bucketSizeNs)

    this.buckets.forTime(bucketTime)
      .forSpan(span, this.peerTagKeys)
      .record(span)
  }

  /**
   * Determines whether a span is eligible for stats computation.
   * Eligible if: top-level, measured, or span.kind is server/client/producer/consumer.
   * @param {object} span - Formatted span object
   * @returns {boolean}
   */
  _isEligible (span) {
    if (span.metrics[TOP_LEVEL_KEY] || span.metrics[MEASURED]) {
      return true
    }
    const spanKind = span.meta?.[SPAN_KIND]
    return !!spanKind && ELIGIBLE_SPAN_KINDS.has(spanKind)
  }

  _serializeBuckets () {
    const { bucketSizeNs } = this
    const serializedBuckets = []

    for (const [timeNs, bucket] of this.buckets.entries()) {
      const bucketAggStats = []

      for (const stats of bucket.values()) {
        bucketAggStats.push(stats.toJSON())
      }

      serializedBuckets.push({
        Start: timeNs,
        Duration: bucketSizeNs,
        Stats: bucketAggStats,
      })
    }

    this.buckets.clear()

    return serializedBuckets
  }
}

module.exports = {
  SpanAggStats,
  SpanAggKey,
  SpanBuckets,
  TimeBuckets,
  SpanStatsProcessor,
  DEFAULT_PEER_TAGS,
  TRILEAN_NOT_SET,
  TRILEAN_TRUE,
  TRILEAN_FALSE,
}
