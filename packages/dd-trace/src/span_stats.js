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
} = require('../../../ext/tags')
const { ORIGIN_KEY, TOP_LEVEL_KEY, SVC_SRC_KEY } = require('./constants')
const { version } = require('./pkg')
const processTags = require('./process-tags')

const { SpanStatsExporter } = require('./exporters/span-stats')

// Datadog gRPC instrumentation tags translated to OTel rpc.* semantic-convention attributes.
const GRPC_METHOD_NAME = 'grpc.method.name'
const GRPC_STATUS_CODE = 'grpc.status.code'

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
    this.errorDuration = 0
    this.topLevelErrors = 0
    this.topLevelDuration = 0
    this.topLevelErrorDuration = 0
    this.okDistribution = new LogCollapsingLowestDenseDDSketch()
    this.errorDistribution = new LogCollapsingLowestDenseDDSketch()
  }

  record (span) {
    const durationNs = span.duration
    this.hits++
    this.duration += durationNs

    const isTopLevel = !!span.metrics[TOP_LEVEL_KEY]
    if (isTopLevel) {
      this.topLevelHits++
      this.topLevelDuration += durationNs
    }

    if (span.error) {
      this.errors++
      this.errorDuration += durationNs
      if (isTopLevel) {
        this.topLevelErrors++
        this.topLevelErrorDuration += durationNs
      }
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
    this.origin = span.meta[ORIGIN_KEY] || ''
    this.endpoint = span.meta[HTTP_ROUTE] || span.meta[HTTP_ENDPOINT] || ''
    this.method = span.meta[HTTP_METHOD] || ''
    this.spanKind = span.meta[SPAN_KIND] || ''
    this.rpcMethod = span.meta[GRPC_METHOD_NAME] || ''
    // The gRPC plugin records the status code as a numeric tag, which span formatting routes into
    // metrics rather than meta; fall back to meta for string-valued tags (e.g. manual instrumentation).
    this.rpcStatusCode = span.metrics?.[GRPC_STATUS_CODE] ?? span.meta[GRPC_STATUS_CODE] ?? ''
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
      this.origin,
      this.spanKind,
      this.rpcMethod,
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
      enabled = false,
      interval = 10,
    } = {},
    hostname,
    port,
    url,
    service,
    env,
    tags,
    version: appVersion,
    otlpTraceMetricsEnabled,
    otelMetricsUrl,
    otelMetricsProtocol,
    ddTraceMetricsOtelFlushInterval,
    otelSemanticsEnabled,
    reportHostname,
  } = {}) {
    this.exporter = new SpanStatsExporter({
      hostname,
      port,
      tags,
      url,
    })
    // OTLP trace metrics flush on a fixed 10s cadence (not driven by OTEL_METRIC_EXPORT_INTERVAL).
    // _DD_TRACE_METRICS_OTEL_FLUSH_INTERVAL is internal and only overrides the cadence in tests.
    let intervalMs = interval * 1e3
    if (otlpTraceMetricsEnabled) {
      intervalMs = Number.isFinite(ddTraceMetricsOtelFlushInterval) && ddTraceMetricsOtelFlushInterval > 0
        ? ddTraceMetricsOtelFlushInterval
        : 10_000
    }
    this.interval = intervalMs / 1e3
    this.bucketSizeNs = intervalMs * 1e6
    this.buckets = new TimeBuckets()
    this.hostname = os.hostname()
    this.enabled = enabled
    this.env = env
    this.tags = tags || {}
    this.sequence = 0
    this.version = appVersion

    if (otlpTraceMetricsEnabled) {
      const { OtlpStatsExporter } = require('./exporters/otlp-span-stats')
      const protocol = otelMetricsProtocol || 'http/json'
      const resourceAttributes = buildResourceAttributes(this.tags, {
        reportHostname,
        otelSemanticsEnabled,
        service,
        env,
        serviceVersion: appVersion,
      })
      this.otlpExporter = new OtlpStatsExporter(
        otelMetricsUrl, protocol, resourceAttributes, otelSemanticsEnabled, service
      )
    }

    if (this.enabled || this.otlpExporter) {
      this.timer = setInterval(this.onInterval.bind(this), intervalMs)
      this.timer.unref?.()
    }
  }

  onInterval () {
    const drained = this._drainBuckets()

    if (this.enabled && !this.otlpExporter) {
      this.exporter.export({
        Hostname: this.hostname,
        Env: this.env,
        Version: this.version || version,
        Stats: this._toLegacyPayload(drained),
        Lang: 'javascript',
        TracerVersion: pkg.version,
        RuntimeID: this.tags['runtime-id'],
        Sequence: ++this.sequence,
        ProcessTags: processTags.serialized,
      })
    }

    if (this.otlpExporter && drained.length > 0) {
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
   * Drains all time buckets and returns the raw data for export.
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

  /**
   * Converts drained buckets to the Datadog /v0.6/stats wire format.
   * @param {Array<{timeNs: number, bucket: SpanBuckets}>} drained
   * @returns {Array}
   */
  _toLegacyPayload (drained) {
    const { bucketSizeNs } = this
    return drained.map(({ timeNs, bucket }) => ({
      Start: timeNs,
      Duration: bucketSizeNs,
      Stats: [...bucket.values()].map(stats => stats.toJSON()),
    }))
  }
}

/**
 * Builds the OTLP resource attributes. Service identity (service.name / service.version /
 * deployment.environment.name) is reported here, as the configured default service of the producing
 * process; spans with a custom service additionally carry service.name on their data point.
 *
 * @param {object} tags
 * @param {{ reportHostname?: boolean, otelSemanticsEnabled?: boolean, service?: string, env?: string,
 *   serviceVersion?: string }} [options]
 *   reportHostname: whether DD_TRACE_REPORT_HOSTNAME is enabled.
 *   otelSemanticsEnabled: when true, only OTel attributes are emitted (no dd.*).
 *   service/env/serviceVersion: the configured default service identity.
 * @returns {import('@opentelemetry/api').Attributes}
 */
function buildResourceAttributes (tags, { reportHostname, otelSemanticsEnabled, service, env, serviceVersion } = {}) {
  // Identify the emitter as the Datadog SDK so the backend can attribute these metrics separately.
  const attrs = {
    'telemetry.sdk.name': 'datadog',
    'telemetry.sdk.language': 'nodejs',
    'telemetry.sdk.version': version,
  }
  // Service identity (OTel attributes, emitted in both modes).
  if (service) attrs['service.name'] = service
  if (serviceVersion) attrs['service.version'] = serviceVersion
  if (env) attrs['deployment.environment.name'] = env
  // Only report host.name when DD_TRACE_REPORT_HOSTNAME is enabled, matching the other OTLP
  // signals (metrics/logs). DD_HOSTNAME is not supported in dd-trace-js, so use os.hostname().
  if (reportHostname) attrs['host.name'] = os.hostname()

  // Datadog-specific resource attributes are emitted only in default mode.
  if (!otelSemanticsEnabled) {
    if (tags?.['runtime-id']) attrs['datadog.runtime_id'] = tags['runtime-id']
    // Emit each process tag (key:value) as an individual datadog.<key> resource attribute.
    const processTagsObject = processTags.tagsObject
    if (processTagsObject) {
      for (const key of Object.keys(processTagsObject)) {
        attrs[`datadog.${key}`] = processTagsObject[key]
      }
    }
  }
  return attrs
}

module.exports = {
  SpanAggStats,
  SpanAggKey,
  SpanBuckets,
  TimeBuckets,
  SpanStatsProcessor,
}
