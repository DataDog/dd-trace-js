'use strict'

const OtlpHttpExporterBase = require('../otlp/otlp_http_exporter_base')
const OtlpTransformer = require('./otlp_transformer')

/**
 * @typedef {import('@opentelemetry/resources').Resource} Resource
 */

/**
 * OtlpHttpMetricExporter exports metrics via OTLP over HTTP.
 *
 * This implementation follows the OTLP HTTP specification:
 * https://opentelemetry.io/docs/specs/otlp/#otlphttp
 *
 * @class OtlpHttpMetricExporter
 * @extends OtlpHttpExporterBase
 */
class OtlpHttpMetricExporter extends OtlpHttpExporterBase {
  /**
   * Creates a new OtlpHttpMetricExporter instance.
   *
   * @param {string} url - OTLP endpoint URL
   * @param {string} headers - Additional HTTP headers as comma-separated key=value string
   * @param {number} timeout - Request timeout in milliseconds
   * @param {string} protocol - OTLP protocol (http/protobuf or http/json)
   * @param {Resource} resource - Resource attributes
   */
  constructor (url, headers, timeout, protocol, resource) {
    super(url, headers, timeout, protocol, '/v1/metrics', 'metrics')
    this.transformer = new OtlpTransformer(resource, protocol)
  }

  /**
   * Exports metrics via OTLP over HTTP.
   *
   * @param {Array} metrics - Array of metric data to export
   * @param {Function} resultCallback - Callback function for export result
   */
  export (metrics, resultCallback) {
    if (metrics.length === 0) {
      resultCallback({ code: 0 })
      return
    }

    const payload = this.transformer.transformMetrics(metrics)
    this._sendPayload(payload, resultCallback)

    // Count total data points across all metrics
    let dataPointCount = 0
    for (const metric of metrics) {
      if (metric.data) {
        dataPointCount += metric.data.length
      }
    }
    this._recordTelemetry('otel.metric_data_points', dataPointCount)
  }
}

module.exports = OtlpHttpMetricExporter
