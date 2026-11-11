'use strict'

const os = require('node:os')
const pkg = require('../../../package.json')

const { LogCollapsingLowestDenseDDSketch } = require('../../../vendor/dist/@datadog/sketches-js')
const {
  MEASURED,
  HTTP_STATUS_CODE,
  HTTP_ENDPOINT,
  HTTP_ROUTE,
  HTTP_METHOD,
  SPAN_KIND,
  GRPC_STATUS_CODE,
  BASE_SERVICE,
} = require('../../../ext/tags')
const { fetchAgentInfo } = require('./agent/info')
const { ORIGIN_KEY, TOP_LEVEL_KEY, SVC_SRC_KEY, GRPC_STATUS_NAMES } = require('./constants')
const id = require('./id')
const log = require('./log')
const { quantizePeerIpAddresses } = require('./quantize-peer-ip-addresses')

const GRPC_STATUS_CODE_MAP = Object.fromEntries(GRPC_STATUS_NAMES.map((name, i) => [name, String(i)]))
/** @type {string[]} */
const NO_PEER_TAGS = []
const BASE_SERVICE_PEER_TAG_KEYS = [BASE_SERVICE]
// What the Agent's span concentrator collapses over-limit peer tags to on the tracer side.
const BLOCKED_PEER_TAGS = ['tracer_blocked_value']
// Span kinds the Agent computes stats for even when a span is neither top-level nor measured.
const STATS_SPAN_KINDS = new Set(['server', 'client', 'producer', 'consumer'])
const ZERO_ID = id('0')
const { version } = require('./pkg')
const processTags = require('./process-tags')

const { SpanStatsExporter } = require('./exporters/span-stats')

const {
  DEFAULT_SPAN_NAME,
  DEFAULT_SERVICE_NAME,
} = require('./encode/tags-processors')

class SpanAggStats {
  constructor (aggKey) {
    this.aggKey = aggKey
    this.hits = 0
    this.topLevelHits = 0
    this.topLevelOkDistribution = new LogCollapsingLowestDenseDDSketch()
    this.topLevelErrorDistribution = new LogCollapsingLowestDenseDDSketch()
    this.nonTopLevelOkDistribution = new LogCollapsingLowestDenseDDSketch()
    this.nonTopLevelErrorDistribution = new LogCollapsingLowestDenseDDSketch()
  }

  record (span) {
    const durationNs = span.duration
    this.hits++
    const isTopLevel = Boolean(span.metrics[TOP_LEVEL_KEY])
    if (isTopLevel) this.topLevelHits++
    if (span.error) {
      if (isTopLevel) this.topLevelErrorDistribution.accept(durationNs)
      else this.nonTopLevelErrorDistribution.accept(durationNs)
    } else {
      if (isTopLevel) this.topLevelOkDistribution.accept(durationNs)
      else this.nonTopLevelOkDistribution.accept(durationNs)
    }
  }

  toJSON () {
    const {
      name, service, resource, type, statusCode, synthetics, method, endpoint, srvSrc,
      spanKind, rpcStatusCode, peerTags,
    } = this.aggKey
    const base = {
      Name: name,
      Service: service,
      Resource: resource,
      Type: type,
      HTTPStatusCode: statusCode,
      Synthetics: synthetics,
      HTTPMethod: method,
      HTTPEndpoint: endpoint,
      srv_src: srvSrc,
      SpanKind: spanKind,
      GRPCStatusCode: rpcStatusCode,
      PeerTags: peerTags,
    }
    const rows = []
    if (this.topLevelHits > 0) {
      rows.push({
        ...base,
        Hits: this.topLevelHits,
        TopLevelHits: this.topLevelHits,
        Errors: this.topLevelErrorDistribution.count,
        Duration: this.topLevelOkDistribution.sum + this.topLevelErrorDistribution.sum,
        OkSummary: this.topLevelOkDistribution.toProto(),
        ErrorSummary: this.topLevelErrorDistribution.toProto(),
      })
    }
    const nonTopLevelHits = this.hits - this.topLevelHits
    if (nonTopLevelHits > 0) {
      rows.push({
        ...base,
        Hits: nonTopLevelHits,
        TopLevelHits: 0,
        Errors: this.nonTopLevelErrorDistribution.count,
        Duration: this.nonTopLevelOkDistribution.sum + this.nonTopLevelErrorDistribution.sum,
        OkSummary: this.nonTopLevelOkDistribution.toProto(), // TODO: custom proto encoding
        ErrorSummary: this.nonTopLevelErrorDistribution.toProto(), // TODO: custom proto encoding
      })
    }
    return rows
  }
}

/**
 * Accept canonical decimal strings or numbers in the non-negative int32 range.
 *
 * @param {unknown} value
 */
function toStatusCode (value) {
  if (typeof value === 'number') return value === (value | 0) && value >= 0 ? value : undefined
  if (typeof value !== 'string') return

  const integer = Number(value) | 0
  return integer >= 0 && String(integer) === value ? integer : undefined
}

/**
 * @param {import('./span_format').FormattedSpan} span
 */
function httpStatusCode (span) {
  const datadogStatus = span.meta[HTTP_STATUS_CODE]
  if (datadogStatus) return datadogStatus

  const otelMetaStatus = toStatusCode(span.meta['http.response.status_code'])
  if (otelMetaStatus !== undefined) return otelMetaStatus

  return toStatusCode(span.metrics?.['http.response.status_code']) ?? 0
}

/**
 * The `key:value` peer tags a span is aggregated on, sorted, mirroring the Agent's own stats computation: the
 * configured keys for client, producer and consumer spans, and only the base service for internal spans of a
 * service override.
 *
 * @param {import('./span_format').FormattedSpan} span
 * @param {string[]} peerTagKeys Keys the Agent advertises in `peer_tags`.
 * @returns {string[]}
 */
function getPeerTags (span, peerTagKeys) {
  if (peerTagKeys.length === 0) return NO_PEER_TAGS

  const { meta } = span
  const spanKind = meta[SPAN_KIND]?.toLowerCase() ?? ''
  let keys
  if ((spanKind === '' || spanKind === 'internal') && meta[BASE_SERVICE]) {
    keys = BASE_SERVICE_PEER_TAG_KEYS
  } else if (spanKind === 'client' || spanKind === 'producer' || spanKind === 'consumer') {
    keys = peerTagKeys
  } else {
    return NO_PEER_TAGS
  }

  let peerTags
  for (const key of keys) {
    const value = meta[key]
    if (value) {
      peerTags ??= []
      peerTags.push(`${key}:${quantizePeerIpAddresses(value)}`)
    }
  }
  return peerTags?.sort() ?? NO_PEER_TAGS
}

class SpanAggKey {
  /**
   * @param {import('./span_format').FormattedSpan} span
   * @param {string[]} [peerTagKeys]
   */
  constructor (span, peerTagKeys = NO_PEER_TAGS) {
    this.name = span.name || DEFAULT_SPAN_NAME
    this.service = span.service || DEFAULT_SERVICE_NAME
    this.resource = span.resource || ''
    this.type = span.type || ''
    this.statusCode = httpStatusCode(span)
    this.synthetics = span.meta[ORIGIN_KEY] === 'synthetics'
    this.endpoint = span.meta[HTTP_ROUTE] || span.meta[HTTP_ENDPOINT] || ''
    this.method = span.meta[HTTP_METHOD] || span.meta['http.request.method'] || ''
    this.srvSrc = span.meta[SVC_SRC_KEY] || ''
    this.spanKind = span.meta[SPAN_KIND] || ''
    // dd gRPC plugin sets a numeric code via setTag; OTel/manual sets a string name via meta.
    // Normalize to numeric string to match the Agent's parseGRPCStatusString convention.
    // Also check OTel semantic aliases (rpc.grpc.status_code, rpc.response.status_code) as
    // the OTel bridge stores attributes under their original key without remapping.
    const grpcCode = span.meta[GRPC_STATUS_CODE] ?? span.metrics?.[GRPC_STATUS_CODE] ??
      span.meta['rpc.grpc.status_code'] ?? span.metrics?.['rpc.grpc.status_code'] ??
      span.meta['rpc.response.status_code'] ?? span.metrics?.['rpc.response.status_code']
    if (typeof grpcCode === 'number') {
      this.rpcStatusCode = String(grpcCode)
    } else if (grpcCode) {
      const upper = String(grpcCode).toUpperCase()
      const numeric = GRPC_STATUS_CODE_MAP[upper]
      if (numeric === undefined) {
        const n = Number(grpcCode)
        this.rpcStatusCode = Number.isInteger(n) && n >= 0 ? String(n) : ''
      } else {
        this.rpcStatusCode = numeric
      }
    } else {
      this.rpcStatusCode = ''
    }
    this.peerTags = getPeerTags(span, peerTagKeys)
  }

  toString () {
    const key = `${this.name},${this.service},${this.resource},${this.type},${this.statusCode},${this.synthetics},` +
      `${this.method},${this.endpoint},${this.srvSrc},${this.spanKind},${this.rpcStatusCode}`
    // Peer tag values may hold comma-separated host lists, so join them on a character tags cannot contain.
    return this.peerTags.length === 0 ? key : `${key},${this.peerTags.join('\0')}`
  }
}

class SpanBuckets extends Map {
  #includeTraceRoot
  #peerTagsCardinalityLimit
  /** @type {Set<string>} */
  #peerTagCombinations = new Set()
  #peerTagsLimitReached = false

  /**
   * @param {boolean} [includeTraceRoot]
   * @param {number} [peerTagsCardinalityLimit] Distinct peer tag combinations kept; 0 keeps all.
   */
  constructor (includeTraceRoot = false, peerTagsCardinalityLimit = 0) {
    super()
    this.#includeTraceRoot = includeTraceRoot
    this.#peerTagsCardinalityLimit = peerTagsCardinalityLimit
  }

  /**
   * @param {import('./span_format').FormattedSpan} span
   * @param {string[]} [peerTagKeys]
   */
  forSpan (span, peerTagKeys) {
    const aggKey = new SpanAggKey(span, peerTagKeys)
    this.#limitPeerTagsCardinality(aggKey)
    const baseKey = aggKey.toString()
    const parentId = span.parent_id
    if (this.#includeTraceRoot && parentId !== undefined && parentId !== null) {
      aggKey.isTraceRoot = parentId.equals(ZERO_ID)
    }
    const key = this.#includeTraceRoot ? `${baseKey},${aggKey.isTraceRoot}` : baseKey

    if (!this.has(key)) {
      this.set(key, new SpanAggStats(aggKey))
    }

    return this.get(key)
  }

  /**
   * Collapse the peer tags of a span onto `tracer_blocked_value` once the bucket holds the maximum number of distinct
   * combinations, like the Agent's span concentrator that dd-trace-go uses. The collapsed entry takes no slot.
   *
   * @param {SpanAggKey} aggKey
   */
  #limitPeerTagsCardinality (aggKey) {
    if (this.#peerTagsCardinalityLimit <= 0 || aggKey.peerTags.length === 0) return

    const combination = aggKey.peerTags.join('\0')
    if (this.#peerTagCombinations.has(combination)) return

    if (this.#peerTagCombinations.size < this.#peerTagsCardinalityLimit) {
      this.#peerTagCombinations.add(combination)
      return
    }

    if (!this.#peerTagsLimitReached) {
      this.#peerTagsLimitReached = true
      log.debug('Stats peer tags cardinality limit (%d) reached for this bucket', this.#peerTagsCardinalityLimit)
    }
    aggKey.peerTags = BLOCKED_PEER_TAGS
  }
}

class TimeBuckets extends Map {
  /** @type {() => SpanBuckets} */
  #createSpanBuckets

  /**
   * @param {boolean} [includeTraceRoot]
   * @param {number} [peerTagsCardinalityLimit] See `SpanBuckets`.
   */
  constructor (includeTraceRoot = false, peerTagsCardinalityLimit = 0) {
    super()
    this.#createSpanBuckets = () => new SpanBuckets(includeTraceRoot, peerTagsCardinalityLimit)
  }

  forTime (time) {
    if (!this.has(time)) {
      this.set(time, this.#createSpanBuckets())
    }

    return this.get(time)
  }
}

class SpanStatsProcessor {
  #config
  /** @type {string[]} Peer tag keys from the Agent's `/info`; none until it answered. */
  #peerTagKeys = NO_PEER_TAGS
  #fetchingAgentInfo = false

  /**
   * @param {import('./config/config-base')} config
   * @param {import('./opentelemetry/metrics/otlp_span_stats_exporter').OtlpStatsExporter} [otlpExporter]
   */
  constructor (config, otlpExporter) {
    const {
      stats: {
        DD_TRACE_STATS_COMPUTATION_ENABLED: enabled = false,
        DD_TRACE_STATS_PEER_TAGS_CARDINALITY_LIMIT: peerTagsCardinalityLimit,
        interval = 10,
      } = {},
      hostname,
      port,
      url,
      env,
      tags,
      version: appVersion,
      reportHostname,
      _DD_TRACE_METRICS_OTEL_FLUSH_INTERVAL: flushIntervalMs,
    } = config
    if (!otlpExporter) {
      this.exporter = new SpanStatsExporter({ hostname, port, tags, url })
    }
    const intervalMs = otlpExporter ? (flushIntervalMs ?? 10_000) : interval * 1e3
    this.interval = intervalMs / 1e3
    this.bucketSizeNs = intervalMs * 1e6
    this.buckets = new TimeBuckets(Boolean(otlpExporter), peerTagsCardinalityLimit)
    // A non-empty client hostname takes precedence over the agent's own hostname for the resulting
    // metrics, so only send it when explicitly requested.
    this.hostname = reportHostname ? os.hostname() : ''
    this.enabled = enabled
    this.otlpExporter = otlpExporter || null
    this.env = env
    this.#config = config
    this.sequence = 0
    this.version = appVersion

    if (this.enabled || this.otlpExporter) {
      this.timer = setInterval(this.onInterval.bind(this), intervalMs)
      this.timer.unref?.()
    }

    this.#refreshPeerTagKeys()
  }

  onInterval () {
    this.#refreshPeerTagKeys()
    this.#flush()
  }

  /**
   * Read the peer tag keys the Agent aggregates on from its `/info`, which the Agent information client caches.
   * Stats computed before the first answer, or while the Agent does not answer, carry no peer tags.
   */
  #refreshPeerTagKeys () {
    if (!this.enabled || this.otlpExporter || this.#fetchingAgentInfo) return

    this.#fetchingAgentInfo = true
    fetchAgentInfo(/** @type {URL} */ (this.#config.url), (error, agentInfo) => {
      this.#fetchingAgentInfo = false
      if (error) {
        log.debug('Could not read the peer tags from the Agent /info: %s', error.message)
        return
      }
      const peerTags = agentInfo?.peer_tags
      this.#peerTagKeys = Array.isArray(peerTags) ? peerTags.filter(key => typeof key === 'string') : NO_PEER_TAGS
    }, { retry: false })
  }

  /**
   * Drains pending span statistics and waits for their export.
   * @param {Function} [done]
   */
  forceFlush (done) {
    this.#flush(done)
  }

  #flush (done) {
    const drained = this.#drainBuckets()

    if (this.enabled && !this.otlpExporter) {
      this.exporter.export({
        Hostname: this.hostname,
        Env: this.env,
        Version: this.version || version,
        Stats: this.#toV06Payload(drained),
        Lang: 'javascript',
        TracerVersion: pkg.version,
        RuntimeID: this.#config.tags['runtime-id'],
        Sequence: ++this.sequence,
        ProcessTags: processTags.serialized,
      }, done)
    } else if (this.otlpExporter && drained.length > 0) {
      if (typeof this.otlpExporter.flush === 'function' && done) {
        // Snapshot requests already in flight before starting this boundary
        // export, so a later invocation cannot extend this lifecycle barrier.
        let pending = 2
        const complete = () => {
          if (--pending === 0) done()
        }
        try {
          this.otlpExporter.flush(complete)
        } catch (error) {
          log.error('Failed to flush OTLP span stats:', error)
          complete()
        }
        try {
          this.otlpExporter.export(drained, this.bucketSizeNs, complete)
        } catch (error) {
          log.error('Failed to export OTLP span stats:', error)
          complete()
        }
      } else {
        this.otlpExporter.export(drained, this.bucketSizeNs, done)
      }
    } else if (this.otlpExporter) {
      if (typeof this.otlpExporter.flush === 'function') this.otlpExporter.flush(done)
      else done?.()
    } else done?.()
  }

  onSpanFinished (span) {
    if (!this.enabled && !this.otlpExporter) return
    if (!span.metrics[TOP_LEVEL_KEY] && !span.metrics[MEASURED] &&
        !STATS_SPAN_KINDS.has(span.meta[SPAN_KIND]?.toLowerCase())) {
      return
    }

    const spanEndNs = span.start + span.duration
    const bucketTime = spanEndNs - (spanEndNs % this.bucketSizeNs)

    this.buckets.forTime(bucketTime)
      .forSpan(span, this.#peerTagKeys)
      .record(span)
  }

  #drainBuckets () {
    const drained = []
    for (const [timeNs, bucket] of this.buckets.entries()) {
      drained.push({ timeNs, bucket })
    }
    this.buckets.clear()
    return drained
  }

  #toV06Payload (drained) {
    const { bucketSizeNs } = this
    return drained.map(({ timeNs, bucket }) => ({
      Start: timeNs,
      Duration: bucketSizeNs,
      Stats: [...bucket.values()].flatMap(stats => stats.toJSON()),
    }))
  }
}

module.exports = {
  SpanAggStats,
  SpanAggKey,
  SpanBuckets,
  TimeBuckets,
  SpanStatsProcessor,
}
