'use strict'

const OtlpHttpExporterBase = require('../otlp/otlp_http_exporter_base')
const OtlpTransformer = require('./otlp_transformer')

/**
 * @typedef {import('@opentelemetry/resources').Resource} Resource
 * @typedef {import('./periodic_metric_reader').AggregatedMetric} AggregatedMetric
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
   * @param {Map<string, AggregatedMetric>} metrics - Map of metric data to export
   *
   * @returns {void}
   */
  export (metrics) {
    if (metrics.size === 0) {
      return
    }

    let dataPointCount = 0
    for (const metric of metrics.values()) {
      if (metric.dataPointMap) {
        dataPointCount += metric.dataPointMap.size
      }
    }

    const additionalTags = [`points:${dataPointCount}`]
    this.recordTelemetry('otel.metrics_export_attempts', 1, additionalTags)

    const payload = this.transformer.transformMetrics(metrics.values())
    this.sendPayload(payload, (result) => {
      if (result.code === 0) {
        this.recordTelemetry('otel.metrics_export_successes', 1, additionalTags)
      }
    })
  }
}

module.exports = OtlpHttpMetricExporter
