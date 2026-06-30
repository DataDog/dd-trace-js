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
} = require('../../../ext/tags')
const { ORIGIN_KEY, TOP_LEVEL_KEY, SVC_SRC_KEY } = require('./constants')
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
      srvSrc,
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
      srv_src: srvSrc,
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
  constructor (span) {
    this.name = span.name || DEFAULT_SPAN_NAME
    this.service = span.service || DEFAULT_SERVICE_NAME
    this.resource = span.resource || ''
    this.type = span.type || ''
    this.statusCode = span.meta[HTTP_STATUS_CODE] || 0
    this.synthetics = span.meta[ORIGIN_KEY] === 'synthetics'
    this.endpoint = span.meta[HTTP_ROUTE] || span.meta[HTTP_ENDPOINT] || ''
    this.method = span.meta[HTTP_METHOD] || ''
    this.srvSrc = span.meta[SVC_SRC_KEY] || ''
    this.origin = span.meta[ORIGIN_KEY] || ''
    this.spanKind = span.meta[SPAN_KIND] || ''
    // gRPC status is the canonical status NAME string and lives in meta; prefer it so the name is
    // preserved. Fall back to metrics for the numeric tag the gRPC plugin records.
    this.rpcStatusCode = span.meta[GRPC_STATUS_CODE] ?? span.metrics?.[GRPC_STATUS_CODE] ?? ''
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
      this.srvSrc,
      this.origin,
      this.spanKind,
      this.rpcStatusCode,
    ].join(',')
  }
}

class SpanBuckets extends Map {
  forSpan (span) {
    const aggKey = new SpanAggKey(span)
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
      DD_TRACE_STATS_COMPUTATION_ENABLED: enabled = false,
      interval = 10,
    } = {},
    hostname,
    port,
    url,
    env,
    tags,
    version: appVersion,
    _DD_TRACE_METRICS_OTEL_FLUSH_INTERVAL: flushIntervalMs,
  } = {}, otlpExporter) {
    if (!otlpExporter) {
      this.exporter = new SpanStatsExporter({ hostname, port, tags, url })
    }
    const intervalMs = otlpExporter ? (flushIntervalMs ?? 10_000) : interval * 1e3
    this.interval = intervalMs / 1e3
    this.bucketSizeNs = intervalMs * 1e6
    this.buckets = new TimeBuckets()
    this.hostname = os.hostname()
    this.enabled = enabled
    this.otlpExporter = otlpExporter || null
    this.env = env
    this.tags = tags || {}
    this.sequence = 0
    this.version = appVersion

    if (this.enabled || this.otlpExporter) {
      this.timer = setInterval(this.onInterval.bind(this), intervalMs)
      this.timer.unref?.()
    }
  }

  onInterval () {
    const drained = this.#drainBuckets()

    if (this.enabled && !this.otlpExporter) {
      this.exporter.export({
        Hostname: this.hostname,
        Env: this.env,
        Version: this.version || version,
        Stats: this.#toLegacyPayload(drained),
        Lang: 'javascript',
        TracerVersion: pkg.version,
        RuntimeID: this.tags['runtime-id'],
        Sequence: ++this.sequence,
        ProcessTags: processTags.serialized,
      })
    } else if (this.otlpExporter && drained.length > 0) {
      this.otlpExporter.export(drained, this.bucketSizeNs)
    }
  }

  onSpanFinished (span) {
    if (!this.enabled && !this.otlpExporter) return
    if (!span.metrics[TOP_LEVEL_KEY] && !span.metrics[MEASURED]) return

    const spanEndNs = span.start + span.duration
    const bucketTime = spanEndNs - (spanEndNs % this.bucketSizeNs)

    this.buckets.forTime(bucketTime)
      .forSpan(span)
      .record(span)
  }

  /**
   * @returns {Array<{timeNs: number, bucket: SpanBuckets}>}
   */
  #drainBuckets () {
    const drained = []
    for (const [timeNs, bucket] of this.buckets.entries()) {
      drained.push({ timeNs, bucket })
    }
    this.buckets.clear()
    return drained
  }

  /**
   * @param {Array<{timeNs: number, bucket: SpanBuckets}>} drained
   * @returns {Array}
   */
  #toLegacyPayload (drained) {
    const { bucketSizeNs } = this
    return drained.map(({ timeNs, bucket }) => ({
      Start: timeNs,
      Duration: bucketSizeNs,
      Stats: [...bucket.values()].map(stats => stats.toJSON()),
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
