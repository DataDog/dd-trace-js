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
  /**
   * @param {object} config
   * @param {object} [config.stats]
   * @param {boolean} [config.stats.enabled]
   * @param {number} [config.stats.interval]
   * @param {object} [config.traceMetrics]
   * @param {boolean} [config.traceMetrics.enabled]
   * @param {string} [config.traceMetrics.url]
   * @param {string} [config.traceMetrics.protocol]
   * @param {number} [config.traceMetrics.interval]
   * @param {string} [config.traceMetrics.histogramType]
   * @param {string} [config.hostname]
   * @param {number} [config.port]
   * @param {string} [config.url]
   * @param {string} [config.env]
   * @param {object} [config.tags]
   * @param {string} [config.version]
   */
  constructor ({
    stats: {
      enabled: statsEnabled = false,
      interval = 10,
    } = {},
    traceMetrics: {
      enabled: traceMetricsEnabled = false,
      url: traceMetricsUrl,
      protocol: traceMetricsProtocol = 'http/protobuf',
      interval: traceMetricsInterval,
      histogramType = 'explicit',
    } = {},
    hostname,
    port,
    url,
    env,
    tags,
    version,
  } = {}) {
    this.enabled = statsEnabled || traceMetricsEnabled
    this.interval = traceMetricsInterval || interval

    this.exporter = statsEnabled
      ? new SpanStatsExporter({ hostname, port, tags, url })
      : null

    if (traceMetricsEnabled) {
      const { OtlpStatsExporter } = require('./exporters/otlp-span-stats')
      this.otlpExporter = new OtlpStatsExporter(
        { url: traceMetricsUrl, protocol: traceMetricsProtocol, histogramType },
        {
          'service.name': tags?.service,
          'deployment.environment': env,
          'service.version': version,
          'host.name': os.hostname(),
          'dd.runtime_id': tags?.['runtime-id'],
        }
      )
    }

    this.bucketSizeNs = this.interval * 1e9
    this.buckets = new TimeBuckets()
    this.hostname = os.hostname()
    this.env = env
    this.tags = tags || {}
    this.sequence = 0
    this.version = version

    if (this.enabled) {
      this.timer = setInterval(this.onInterval.bind(this), this.interval * 1e3)
      this.timer.unref()
    }
  }

  onInterval () {
    const drained = this._drainBuckets()
    if (!drained.length) return

    if (this.exporter) {
      const serialized = drained.map(({ timeNs, bucket }) => ({
        Start: timeNs,
        Duration: this.bucketSizeNs,
        Stats: Array.from(bucket.values(), s => s.toJSON()),
      }))

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

    if (this.otlpExporter) {
      this.otlpExporter.export(drained, this.bucketSizeNs)
    }
  }

  onSpanFinished (span) {
    if (!this.enabled) return
    if (!span.metrics[TOP_LEVEL_KEY] && !span.metrics[MEASURED]) return

    const spanEndNs = span.startTime + span.duration
    const bucketTime = spanEndNs - (spanEndNs % this.bucketSizeNs)

    this.buckets.forTime(bucketTime)
      .forSpan(span)
      .record(span)
  }

  /**
   * Drains all accumulated time buckets and returns raw bucket data.
   * Clears the internal bucket map after draining.
   * @returns {Array<{timeNs: number, bucket: SpanBuckets}>}
   */
  _drainBuckets () {
    const drained = []

    for (const [timeNs, bucket] of this.buckets.entries()) {
      drained.push({ timeNs, bucket })
    }

    this.buckets.clear()
    return drained
  }
}

module.exports = {
  SpanAggStats,
  SpanAggKey,
  SpanBuckets,
  TimeBuckets,
  SpanStatsProcessor,
}
