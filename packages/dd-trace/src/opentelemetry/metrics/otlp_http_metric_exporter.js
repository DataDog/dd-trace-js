'use strict'

const OtlpHttpExporterBase = require('../otlp/otlp_http_exporter_base')
const OtlpTransformer = require('./otlp_transformer')

/**
 * @typedef {import('@opentelemetry/resources').Resource} Resource
 * @typedef {import('@./instruments').Instrument} Instrument
 */

/**
 * OtlpHttpMetricExporter exports metrics via OTLP over HTTP.
 *
 * @class OtlpHttpMetricExporter
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
   * @param {Array<Instrument>} metrics - Array of metric data to export
   * @param {Function} resultCallback - Callback function for export result
   *
   * @returns {void}
   */
  export (metrics, resultCallback) {
    if (metrics.length === 0) {
      resultCallback({ code: 0 })
      return
    }

    let dataPointCount = 0
    for (const metric of metrics) {
      if (metric.data) {
        dataPointCount += metric.data.length
      }
    }

    const telemetryTags = [...this.telemetryTags, `points:${dataPointCount}`]
    this.recordTelemetry('otel.metrics_export_attempts', 1, telemetryTags)

    const payload = this.transformer.transformMetrics(metrics)
    this.sendPayload(payload, (result) => {
      if (result.code === 0) {
        this.recordTelemetry('otel.metrics_export_successes', 1, telemetryTags)
      }
      resultCallback(result)
    })
  }
}

module.exports = OtlpHttpMetricExporter
