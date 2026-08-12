'use strict'

const log = require('../../log')
const OtlpHttpExporterBase = require('../otlp/otlp_http_exporter_base')
const OtlpStatsTransformer = require('./otlp_span_stats_transformer')

class OtlpStatsExporter extends OtlpHttpExporterBase {
  #transformer

  /**
   * @param {string} url
   * @param {string} protocol
   * @param {import('@opentelemetry/api').Attributes} resourceAttributes
   * @param {boolean} [otelSemanticsEnabled]
   * @param {string} [defaultService]
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
   * @param {Function} [done] Called after the HTTP export completes
   */
  export (drained, bucketSizeNs, done) {
    if (drained.length === 0) return done?.()
    const payload = this.#transformer.transform(drained, bucketSizeNs)
    this.sendPayload(payload, (result) => {
      if (result.code !== 0) {
        log.error('Failed to export span stats: %s', result.error?.message)
      }
      done?.()
    })
  }
}

module.exports = { OtlpStatsExporter }
