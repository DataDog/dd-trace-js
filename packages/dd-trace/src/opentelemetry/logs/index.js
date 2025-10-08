'use strict'

const os = require('os')

/**
 * @typedef {import('../../config')} Config
 */

/**
 * @fileoverview OpenTelemetry Logs Implementation for dd-trace-js
 *
 * This package provides a custom OpenTelemetry Logs implementation that integrates
 * with the Datadog tracing library. It includes all necessary components for
 * emitting, processing, and exporting log records via OTLP (OpenTelemetry Protocol).
 *
 * Key Components:
 * - LoggerProvider: Main entry point for creating loggers
 * - Logger: Provides methods to emit log records
 * - BatchLogRecordProcessor: Processes log records in batches for efficient export
 * - OtlpHttpLogExporter: Exports log records via OTLP over HTTP
 * - OtlpTransformer: Transforms log records to OTLP format
 *
 * This is a custom implementation to avoid pulling in the full OpenTelemetry SDK,
 * based on OTLP Protocol v1.7.0. It supports both protobuf and JSON serialization
 * formats and integrates with Datadog's configuration system.
 *
 * @package
 */

const LoggerProvider = require('./logger_provider')
const BatchLogRecordProcessor = require('./batch_log_processor')
const OtlpHttpLogExporter = require('./otlp_http_log_exporter')

/**
 * Initializes OpenTelemetry Logs support
 * @param {Config} config - Tracer configuration instance
 */
function initializeOpenTelemetryLogs (config) {
  // Build resource attributes
  const resourceAttributes = {
    'service.name': config.service,
    'service.version': config.version,
    'deployment.environment': config.env
  }

  // Add all tracer tags (includes DD_TAGS, OTEL_RESOURCE_ATTRIBUTES, DD_TRACE_TAGS, etc.)
  // Exclude Datadog-style keys that duplicate OpenTelemetry standard keys
  if (config.tags) {
    const filteredTags = { ...config.tags }
    delete filteredTags.service
    delete filteredTags.version
    delete filteredTags.env
    Object.assign(resourceAttributes, filteredTags)
  }

  // Add host.name if reportHostname is enabled
  if (config.reportHostname) {
    resourceAttributes['host.name'] = os.hostname()
  }

  // Create OTLP exporter using resolved config values
  const exporter = new OtlpHttpLogExporter(
    config.otelLogsUrl,
    config.otelLogsHeaders,
    config.otelLogsTimeout,
    config.otelLogsProtocol,
    resourceAttributes
  )

  // Create batch processor for exporting logs to Datadog Agent
  const processor = new BatchLogRecordProcessor(
    exporter,
    config.otelLogsBatchTimeout,
    config.otelLogsMaxExportBatchSize
  )

  // Create logger provider with processor for Datadog Agent export
  const loggerProvider = new LoggerProvider({ processor })

  // Register the logger provider globally with OpenTelemetry API
  loggerProvider.register()
}

module.exports = {
  LoggerProvider,
  initializeOpenTelemetryLogs
}
