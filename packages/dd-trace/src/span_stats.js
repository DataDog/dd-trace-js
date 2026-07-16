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
const { ORIGIN_KEY, TOP_LEVEL_KEY, SVC_SRC_KEY, GRPC_STATUS_NAMES } = require('./constants')
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
      spanKind, rpcStatusCode,
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
    this.spanKind = span.meta[SPAN_KIND] || ''
    // dd gRPC plugin sets a numeric code via setTag; OTel/manual sets a string name via meta.
    const grpcCode = span.meta[GRPC_STATUS_CODE] ?? span.metrics?.[GRPC_STATUS_CODE]
    this.rpcStatusCode = typeof grpcCode === 'number'
      ? (GRPC_STATUS_NAMES[grpcCode] ?? String(grpcCode))
      : (grpcCode ?? '')
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
        Stats: this.#toV06Payload(drained),
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
