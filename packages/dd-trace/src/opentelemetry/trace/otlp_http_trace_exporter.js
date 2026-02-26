'use strict'

const OtlpHttpExporterBase = require('../otlp/otlp_http_exporter_base')
const OtlpTraceTransformer = require('./otlp_transformer')

/**
 * OtlpHttpTraceExporter exports DD-formatted spans via OTLP over HTTP/JSON.
 *
 * This implementation follows the OTLP HTTP v1.7.0 specification:
 * https://opentelemetry.io/docs/specs/otlp/#otlphttp
 *
 * It receives DD-formatted spans (from span_format.js), transforms them
 * to OTLP ExportTraceServiceRequest JSON format, and sends them to the
 * configured OTLP endpoint via HTTP POST.
 *
 * @class OtlpHttpTraceExporter
 * @augments OtlpHttpExporterBase
 */
class OtlpHttpTraceExporter extends OtlpHttpExporterBase {
  /**
   * Creates a new OtlpHttpTraceExporter instance.
   *
   * @param {string} url - OTLP endpoint URL
   * @param {string} headers - Additional HTTP headers as comma-separated key=value string
   * @param {number} timeout - Request timeout in milliseconds
   * @param {import('@opentelemetry/api').Attributes} resourceAttributes - Resource attributes
   */
  constructor (url, headers, timeout, resourceAttributes) {
    super(url, headers, timeout, 'http/json', '/v1/traces', 'traces')
    this.transformer = new OtlpTraceTransformer(resourceAttributes)
  }

  /**
   * Exports DD-formatted spans via OTLP over HTTP.
   *
   * @param {import('./otlp_transformer').DDFormattedSpan[]} spans - Array of DD-formatted spans to export
   * @returns {void}
   */
  export (spans) {
    if (spans.length === 0) {
      return
    }

    const additionalTags = [`spans:${spans.length}`]
    this.recordTelemetry('otel.traces_export_attempts', 1, additionalTags)

    const payload = this.transformer.transformSpans(spans)
    this.sendPayload(payload, (result) => {
      if (result.code === 0) {
        this.recordTelemetry('otel.traces_export_successes', 1, additionalTags)
      }
    })
  }
}

module.exports = OtlpHttpTraceExporter
