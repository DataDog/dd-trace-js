'use strict'

const OtlpHttpExporterBase = require('../otlp/otlp_http_exporter_base')
const OtlpTransformer = require('./otlp_transformer')

/**
 * @typedef {import('@opentelemetry/api').Attributes} Attributes
 * @typedef {import('@opentelemetry/api-logs').LogRecord} LogRecord
 */

/**
 * OtlpHttpLogExporter exports log records via OTLP over HTTP.
 *
 * This implementation follows the OTLP HTTP v1.7.0 specification:
 * https://opentelemetry.io/docs/specs/otlp/#otlphttp
 *
 * @class OtlpHttpLogExporter
 * @augments OtlpHttpExporterBase
 */
class OtlpHttpLogExporter extends OtlpHttpExporterBase {
  /**
   * Creates a new OtlpHttpLogExporter instance.
   *
   * @param {string} url - OTLP endpoint URL
   * @param {Record<string, string>|undefined} headers - Additional HTTP headers parsed from the
   *   corresponding `OTEL_EXPORTER_OTLP_*_HEADERS` env by the MAP parser.
   * @param {number} timeout - Request timeout in milliseconds
   * @param {string} protocol - OTLP protocol (http/protobuf or http/json)
   * @param {Attributes} resourceAttributes - Resource attributes
   */
  constructor (url, headers, timeout, protocol, resourceAttributes) {
    super(url, headers, timeout, protocol, 'logs')
    this.transformer = new OtlpTransformer(resourceAttributes, protocol)
  }

  /**
   * Recomputes the resource attributes baked into the transformer (e.g. after a MicroVM clone
   * resume regenerates `runtime-id`).
   *
   * @param {Attributes} resourceAttributes - Resource attributes
   */
  updateResourceAttributes (resourceAttributes) {
    this.transformer.updateResourceAttributes(resourceAttributes)
  }

  /**
   * Exports log records via OTLP over HTTP.
   *
   * @param {LogRecord[]} logRecords - Array of enriched log records to export
   * @param {Function} resultCallback - Callback function for export result
   *
   * @returns {void}
   */
  export (logRecords, resultCallback) {
    if (logRecords.length === 0) {
      resultCallback({ code: 0 })
      return
    }

    const payload = this.transformer.transformLogRecords(logRecords)
    this.sendPayload(payload, resultCallback)
    this.recordTelemetry('otel.log_records', logRecords.length)
  }
}

module.exports = OtlpHttpLogExporter
