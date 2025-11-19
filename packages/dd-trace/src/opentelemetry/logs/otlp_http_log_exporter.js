'use strict'

const OtlpHttpExporterBase = require('../otlp/otlp_http_exporter_base')
const OtlpTransformer = require('./otlp_transformer')

/**
 * @typedef {import('@opentelemetry/resources').Resource} Resource
 * @typedef {import('@opentelemetry/api-logs').LogRecord} LogRecord
 */

/**
 * OtlpHttpLogExporter exports log records via OTLP over HTTP.
 *
 * This implementation follows the OTLP HTTP specification:
 * https://opentelemetry.io/docs/specs/otlp/#otlphttp
 *
 * @class OtlpHttpLogExporter
 * @extends OtlpHttpExporterBase
 */
class OtlpHttpLogExporter extends OtlpHttpExporterBase {
  /**
   * Creates a new OtlpHttpLogExporter instance.
   *
   * @param {string} url - OTLP endpoint URL
   * @param {string} headers - Additional HTTP headers as comma-separated key=value string
   * @param {number} timeout - Request timeout in milliseconds
   * @param {string} protocol - OTLP protocol (http/protobuf or http/json)
   * @param {Resource} resource - Resource attributes
   */
  constructor (url, headers, timeout, protocol, resource) {
    super(url, headers, timeout, protocol, '/v1/logs', 'logs')
    this.transformer = new OtlpTransformer(resource, protocol)
  }

  /**
   * Exports log records via OTLP over HTTP.
   *
   * @param {LogRecord[]} logRecords - Array of enriched log records to export
   * @param {Function} resultCallback - Callback function for export result
   */
  export (logRecords, resultCallback) {
    if (logRecords.length === 0) {
      resultCallback({ code: 0 })
      return
    }

    const payload = this.transformer.transformLogRecords(logRecords)
    this._sendPayload(payload, resultCallback)
    this._recordTelemetry('otel.log_records', logRecords.length)
  }
}

module.exports = OtlpHttpLogExporter
