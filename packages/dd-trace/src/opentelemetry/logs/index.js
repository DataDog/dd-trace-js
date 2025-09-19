'use strict'

/**
 * @fileoverview OpenTelemetry Logs Implementation for dd-trace-js
 *
 * Custom implementation to avoid pulling in the full OpenTelemetry SDK.
 * Based on OTLP Protocol v1.7.0.
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
