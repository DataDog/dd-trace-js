'use strict'

const OtlpHttpExporterBase = require('../otlp/otlp_http_exporter_base')
const OtlpTransformer = require('./otlp_transformer')

/**
 * @typedef {import('@opentelemetry/resources').Resource} Resource
 */

/**
 * OtlpHttpMetricExporter exports metrics via OTLP over HTTP.
 *
 * This implementation follows the OTLP HTTP v1.7.0 specification:
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

    // Count total data points across all metrics
    let dataPointCount = 0
    for (const metric of metrics) {
      if (metric.data) {
        dataPointCount += metric.data.length
      }
    }

    // Record export attempt with tags
    const telemetryTags = [...this._getTelemetryTags(), `points:${dataPointCount}`]
    this._recordTelemetry('otel.metrics_export_attempts', 1, telemetryTags)

    const payload = this.transformer.transformMetrics(metrics)
    this._sendPayload(payload, (result) => {
      // Record success if export succeeded
      if (result.code === 0) {
        this._recordTelemetry('otel.metrics_export_successes', 1, telemetryTags)
      }
      resultCallback(result)
    })
  }
}

module.exports = OtlpHttpMetricExporter
