'use strict'

const os = require('os')

/**
 * @typedef {import('../../config')} Config
 */

/**
 * @fileoverview OpenTelemetry Metrics Implementation for dd-trace-js
 *
 * This package provides a custom OpenTelemetry Metrics implementation that integrates
 * with the Datadog tracing library. It includes all necessary components for
 * creating instruments, recording measurements, and exporting metrics via OTLP.
 *
 * Key Components:
 * - MeterProvider: Main entry point for creating meters
 * - Meter: Provides methods to create metric instruments
 * - Instruments: Gauge, Counter, UpDownCounter, ObservableGauge, ObservableCounter, ObservableUpDownCounter, Histogram
 * - PeriodicMetricReader: Collects and exports instruments (metrics) at regular intervals
 * - OtlpHttpMetricExporter: Exports instruments (metrics) via OTLP over HTTP
 * - OtlpTransformer: Transforms instruments (metrics) to OTLP format
 *
 * This is a custom implementation to avoid pulling in the full OpenTelemetry SDK,
 * based on OTLP Protocol v1.7.0. It supports both protobuf and JSON serialization
 * formats and integrates with Datadog's configuration system.
 *
 * @package
 */

const MeterProvider = require('./meter_provider')
const PeriodicMetricReader = require('./periodic_metric_reader')
const OtlpHttpMetricExporter = require('./otlp_http_metric_exporter')

/**
 * Initializes OpenTelemetry Metrics support
 * @param {Config} config - Tracer configuration instance
 */
function initializeOpenTelemetryMetrics (config) {
  // Build resource attributes
  const resourceAttributes = {
    'service.name': config.service,
    'service.version': config.version,
    'deployment.environment': config.env
  }

  if (config.tags) {
    const filteredTags = { ...config.tags }
    delete filteredTags.service
    delete filteredTags.version
    delete filteredTags.env
    Object.assign(resourceAttributes, filteredTags)
  }

  if (config.reportHostname) {
    resourceAttributes['host.name'] = os.hostname()
  }

  const exporter = new OtlpHttpMetricExporter(
    config.otelMetricsUrl,
    config.otelMetricsHeaders,
    config.otelMetricsTimeout,
    config.otelMetricsProtocol,
    resourceAttributes
  )

  const reader = new PeriodicMetricReader(
    exporter,
    config.otelMetricsExportInterval,
    config.otelMetricsTemporalityPreference
  )

  const meterProvider = new MeterProvider({ reader })

  meterProvider.register()
}

module.exports = {
  MeterProvider,
  initializeOpenTelemetryMetrics
}
