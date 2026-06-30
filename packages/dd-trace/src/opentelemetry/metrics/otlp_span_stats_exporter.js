'use strict'

const log = require('../../log')
const OtlpHttpExporterBase = require('../otlp/otlp_http_exporter_base')
const OtlpStatsTransformer = require('./otlp_span_stats_transformer')

/**
 * Exports span stats as OTLP metrics to a /v1/metrics endpoint.
 *
 * Active when OTEL_TRACES_SPAN_METRICS_ENABLED=true (or auto-enabled when both
 * OTEL_TRACES_EXPORTER=otlp and DD_METRICS_OTEL_ENABLED=true are set).
 * Mutually exclusive with the native /v0.6/stats exporter.
 *
 * @class OtlpStatsExporter
 * @augments OtlpHttpExporterBase
 */
class OtlpStatsExporter extends OtlpHttpExporterBase {
  #transformer

  /**
   * @param {string} url
   * @param {string} protocol - 'http/protobuf' or 'http/json'
   * @param {import('@opentelemetry/api').Attributes} resourceAttributes
   * @param {boolean} [otelSemanticsEnabled] - omit dd.* attributes when true
   * @param {string} [defaultService] - DD_SERVICE; data points carry service.name only when different
   * @param {Record<string, string>} [headers]
   * @param {number} [timeout]
   */
  constructor (url, protocol, resourceAttributes, otelSemanticsEnabled = false, defaultService = '',
    headers, timeout = 10_000) {
    super(url, headers, timeout, protocol, 'span-stats')
    this.#transformer = new OtlpStatsTransformer(resourceAttributes, protocol, otelSemanticsEnabled, defaultService)
  }

  /**
   * @param {Array<{timeNs: number, bucket: import('../../span_stats').SpanBuckets}>} drained
   * @param {number} bucketSizeNs
   */
  export (drained, bucketSizeNs) {
    if (drained.length === 0) return
    const payload = this.#transformer.transform(drained, bucketSizeNs)
    this.sendPayload(payload, (result) => {
      if (result.code !== 0) {
        log.error('Failed to export span stats: %s', result.error?.message)
      }
    })
  }
}

module.exports = { OtlpStatsExporter }
