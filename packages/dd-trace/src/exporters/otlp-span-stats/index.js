'use strict'

const OtlpHttpExporterBase = require('../../opentelemetry/otlp/otlp_http_exporter_base')
const OtlpStatsTransformer = require('./transformer')

/**
 * @typedef {import('../../../span_stats').SpanBuckets} SpanBuckets
 * @typedef {{ timeNs: number, bucket: SpanBuckets }} DrainedBucket
 */

/**
 * Exports span stats as OTLP metrics to a configurable HTTP endpoint.
 *
 * Acts as an additional flush consumer alongside the existing SpanStatsExporter,
 * sharing the same raw bucket data drained by SpanStatsProcessor.onInterval().
 *
 * @class OtlpStatsExporter
 * @augments OtlpHttpExporterBase
 */
class OtlpStatsExporter extends OtlpHttpExporterBase {
  /**
   * @param {object} config
   * @param {string} config.url - OTLP metrics endpoint URL
   * @param {string} [config.protocol] - OTLP protocol (http/protobuf or http/json)
   * @param {string} [config.histogramType] - Histogram encoding (explicit or exponential)
   * @param {import('@opentelemetry/api').Attributes} resourceAttributes - Resource-level attributes
   */
  constructor (config, resourceAttributes) {
    const { url, protocol = 'http/protobuf', histogramType = 'explicit' } = config
    super(url, undefined, 10_000, protocol, '/v1/metrics', 'span-stats')
    this.transformer = new OtlpStatsTransformer(resourceAttributes, this.protocol, histogramType)
  }

  /**
   * Exports drained span bucket data as OTLP metrics.
   *
   * @param {DrainedBucket[]} drained - Raw drained bucket entries from SpanStatsProcessor
   * @param {number} bucketSizeNs - Bucket duration in nanoseconds
   * @returns {void}
   */
  export (drained, bucketSizeNs) {
    if (!drained.length) return

    let pointCount = 0
    for (const { bucket } of drained) {
      pointCount += bucket.size
    }

    const additionalTags = [`points:${pointCount}`]
    this.recordTelemetry('otel.span_stats_export_attempts', 1, additionalTags)

    const payload = this.transformer.transform(drained, bucketSizeNs)
    this.sendPayload(payload, (result) => {
      if (result.code === 0) {
        this.recordTelemetry('otel.span_stats_export_successes', 1, additionalTags)
      }
    })
  }
}

module.exports = { OtlpStatsExporter }
