'use strict'

const { buildResourceAttributes, registerResourceAttributeRefresh } = require('../resource-attributes')

/**
 * @typedef {import('../../config')} Config
 */

/**
 * OpenTelemetry Logs Implementation for `dd-trace-js`
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

const { registerTelemetryFlusher } = require('../../flush')
const LoggerProvider = require('./logger_provider')
const BatchLogRecordProcessor = require('./batch_log_processor')
const OtlpHttpLogExporter = require('./otlp_http_log_exporter')

/**
 * Initializes OpenTelemetry Logs support
 * @param {import('../../config/config-base')} config - Tracer configuration instance
 */
function initializeOpenTelemetryLogs (config) {
  // Create OTLP exporter using resolved config values
  const exporter = new OtlpHttpLogExporter(
    config.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT,
    config.OTEL_EXPORTER_OTLP_LOGS_HEADERS,
    config.OTEL_EXPORTER_OTLP_LOGS_TIMEOUT,
    config.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL,
    buildResourceAttributes(config)
  )

  // Create batch processor for exporting logs to Datadog Agent
  const processor = new BatchLogRecordProcessor(
    exporter,
    config.OTEL_BSP_SCHEDULE_DELAY,
    config.OTEL_BSP_MAX_EXPORT_BATCH_SIZE
  )

  // Create logger provider with processor for Datadog Agent export
  const loggerProvider = new LoggerProvider({ processor })

  // Expose this provider to application calls through the OpenTelemetry Logs API.
  loggerProvider.register()

  // Include final log batches in lifecycle retention with trace delivery.
  registerTelemetryFlusher(done => loggerProvider.forceFlush(done))

  registerResourceAttributeRefresh(exporter, () => buildResourceAttributes(config))
}

module.exports = {
  LoggerProvider,
  initializeOpenTelemetryLogs,
}
