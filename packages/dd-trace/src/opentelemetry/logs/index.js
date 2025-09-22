'use strict'

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
const Logger = require('./logger')
const BatchLogRecordProcessor = require('./batch_log_processor')
const OtlpHttpLogExporter = require('./otlp_http_log_exporter')
const OtlpTransformer = require('./otlp_transformer')

module.exports = {
  LoggerProvider,
  Logger,
  BatchLogRecordProcessor,
  OtlpHttpLogExporter,
  OtlpTransformer
}
