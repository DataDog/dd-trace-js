'use strict'

/**
 * @fileoverview OpenTelemetry Metrics Implementation for dd-trace-js
 *
 * This package provides a custom OpenTelemetry Metrics implementation that integrates
 * with the Datadog tracing library. It includes all necessary components for
 * creating, collecting, and exporting metrics via OTLP (OpenTelemetry Protocol).
 *
 * Key Components:
 * - MeterProvider: Main entry point for creating meters
 * - Meter: Provides methods to create metric instruments (counters, histograms, etc.)
 * - MetricReader: Periodically collects and exports metrics
 * - OtlpHttpMetricExporter: Exports metrics via OTLP over HTTP
 * - OtlpTransformer: Transforms metrics to OTLP format
 *
 * This is a custom implementation to avoid pulling in the full OpenTelemetry SDK,
 * based on OTLP Protocol v1.7.0. It supports both protobuf and JSON serialization
 * formats and integrates with Datadog's configuration system.
 *
 * @package
 */

const MeterProvider = require('./meter_provider')
const Meter = require('./meter')
const MetricReader = require('./metric_reader')
const OtlpHttpMetricExporter = require('./otlp_http_metric_exporter')
const OtlpTransformer = require('./otlp_transformer')

module.exports = {
  MeterProvider,
  Meter,
  MetricReader,
  OtlpHttpMetricExporter,
  OtlpTransformer
}
