'use strict'

const log = require('../../log')
const OtlpHttpExporterBase = require('../../opentelemetry/otlp/otlp_http_exporter_base')
const OtlpStatsTransformer = require('./transformer')

/**
 * Exports span stats as OTLP metrics to a /v1/metrics endpoint.
 *
 * Mutually exclusive with the Datadog /v0.6/stats exporter: it is used when
 * OTEL_CLIENT_STATS_COMPUTATION_ENABLED=true (or auto-enabled when both
 * OTEL_TRACES_EXPORTER=otlp and DD_METRICS_OTEL_ENABLED=true are set).
 *
 * @class OtlpStatsExporter
 * @augments OtlpHttpExporterBase
 */
class OtlpStatsExporter extends OtlpHttpExporterBase {
  /**
   * @param {string} url - Full OTLP metrics endpoint URL (e.g. http://localhost:4318/v1/metrics)
   * @param {string} protocol - OTLP protocol (http/protobuf or http/json)
   * @param {import('@opentelemetry/api').Attributes} resourceAttributes - Resource attributes
   * @param {boolean} [otelSemanticsEnabled] - When true, only OTel attributes are emitted (no dd.*)
   * @param {string} [defaultService] - The configured default service (DD_SERVICE), reported on the
   *   resource; a data point carries service.name only when its span's service differs from this.
   */
  constructor (url, protocol, resourceAttributes, otelSemanticsEnabled = false, defaultService = '') {
    super(url, undefined, 10_000, protocol, 'span-stats')
    this.transformer = new OtlpStatsTransformer(resourceAttributes, protocol, otelSemanticsEnabled, defaultService)
  }

  /**
   * Exports drained span stats buckets as OTLP metrics.
   *
   * @param {Array<{timeNs: number, bucket: import('../../span_stats').SpanBuckets}>} drained
   * @param {number} bucketSizeNs - Bucket duration in nanoseconds
   * @returns {void}
   */
  export (drained, bucketSizeNs) {
    if (drained.length === 0) return

    let pointCount = 0
    for (const { bucket } of drained) {
      pointCount += bucket.size
    }

    const additionalTags = [`points:${pointCount}`]
    this.recordTelemetry('dd.trace.span_stats_export_attempts', 1, additionalTags)

    const payload = this.transformer.transform(drained, bucketSizeNs)
    this.sendPayload(payload, (result) => {
      if (result.code === 0) {
        this.recordTelemetry('dd.trace.span_stats_export_successes', 1, additionalTags)
      } else {
        log.error('Failed to export span stats: %s', result.error?.message)
      }
    })
  }
}

module.exports = { OtlpStatsExporter }
