'use strict'

const { SpanStatsExporter } = require('../span-stats')
const OtlpHttpMetricExporter = require('../../opentelemetry/metrics/otlp_http_metric_exporter')
const OtlpStatsTransformer = require('./transformer')

/**
 * @typedef {import('../../../span_stats').SpanBuckets} SpanBuckets
 * @typedef {{ timeNs: number, bucket: SpanBuckets }} DrainedBucket
 */

/**
 * Exports span stats as OTLP metrics to a configurable HTTP endpoint.
 *
 * Extends SpanStatsExporter and overrides _serializeBuckets to produce
 * OTLP ExportMetricsServiceRequest payloads. Uses OtlpHttpMetricExporter
 * for transport so the same HTTP/telemetry infrastructure is reused.
 *
 * @class OtlpSpanStatsExporter
 * @augments SpanStatsExporter
 */
class OtlpSpanStatsExporter extends SpanStatsExporter {
  /**
   * @param {object} config
   * @param {string} config.url - OTLP metrics endpoint URL
   * @param {string} [config.protocol] - OTLP protocol (http/protobuf or http/json)
   * @param {string} [config.histogramType] - Histogram encoding (explicit or exponential)
   * @param {import('@opentelemetry/api').Attributes} resourceAttributes - Resource-level attributes
   */
  constructor (config, resourceAttributes) {
    super({})
    const { url, protocol = 'http/protobuf', histogramType = 'explicit' } = config
    this._metricsExporter = new OtlpHttpMetricExporter(url, undefined, 10_000, protocol, resourceAttributes)
    this._transformer = new OtlpStatsTransformer(resourceAttributes, this._metricsExporter.protocol, histogramType)
  }

  /**
   * Serializes drained bucket data into a serialized OTLP metrics payload.
   *
   * @param {DrainedBucket[]} drained
   * @param {number} bucketSizeNs
   * @returns {Buffer} Serialized OTLP payload
   */
  _serializeBuckets (drained, bucketSizeNs) {
    return this._transformer.transform(drained, bucketSizeNs)
  }

  /**
   * Exports drained bucket data as OTLP metrics.
   *
   * @param {DrainedBucket[]} drained
   * @param {number} bucketSizeNs
   */
  export (drained, bucketSizeNs) {
    if (!drained.length) return

    let pointCount = 0
    for (const { bucket } of drained) {
      pointCount += bucket.size
    }

    const additionalTags = [`points:${pointCount}`]
    this._metricsExporter.recordTelemetry('otel.span_stats_export_attempts', 1, additionalTags)

    const payload = this._serializeBuckets(drained, bucketSizeNs)
    this._metricsExporter.sendPayload(payload, (result) => {
      if (result.code === 0) {
        this._metricsExporter.recordTelemetry('otel.span_stats_export_successes', 1, additionalTags)
      }
    })
  }
}

module.exports = { OtlpSpanStatsExporter }
