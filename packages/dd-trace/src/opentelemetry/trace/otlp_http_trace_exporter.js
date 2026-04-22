'use strict'

const OtlpHttpExporterBase = require('../otlp/otlp_http_exporter_base')
const { SAMPLING_PRIORITY_KEY } = require('../../constants')
const { AUTO_KEEP } = require('../../../../../ext/priority')
const OtlpTraceTransformer = require('./otlp_transformer')

/**
 * OtlpHttpTraceExporter exports DD-formatted spans via OTLP over HTTP/JSON.
 *
 * This implementation follows the OTLP HTTP specification:
 * https://opentelemetry.io/docs/specs/otlp/#otlphttp
 *
 * It receives DD-formatted spans (from span_format.js), transforms them
 * to OTLP ExportTraceServiceRequest JSON format, and sends them to the
 * configured OTLP endpoint via HTTP POST.
 *
 * TODO: Add batch handling similar to the OpenTelemetry SDK Batch Processor
 * (https://opentelemetry.io/docs/specs/otel/trace/sdk/#batching-processor).
 * Currently each finished trace is sent as its own HTTP request, which is
 * unsuitable for high-traffic production environments. The config values
 * `otelBatchTimeout`, `otelMaxExportBatchSize`, and `otelMaxQueueSize`
 * (OTEL_BSP_*) are already defined and should drive that implementation.
 *
 * @class OtlpHttpTraceExporter
 * @augments OtlpHttpExporterBase
 */
class OtlpHttpTraceExporter extends OtlpHttpExporterBase {
  #transformer

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
    this.#transformer = new OtlpTraceTransformer(resourceAttributes)
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

    // Drop unsampled traces — OTLP endpoints have no agent-side sampling.
    const priority = spans[0]?.metrics?.[SAMPLING_PRIORITY_KEY]
    if (priority !== undefined && priority < AUTO_KEEP) {
      return
    }

    const additionalTags = [`spans:${spans.length}`]
    this.recordTelemetry('otel.traces_export_attempts', 1, additionalTags)

    const payload = this.#transformer.transformSpans(spans)
    this.sendPayload(payload, (result) => {
      if (result.code === 0) {
        this.recordTelemetry('otel.traces_export_successes', 1, additionalTags)
      }
    })
  }
}

module.exports = OtlpHttpTraceExporter
