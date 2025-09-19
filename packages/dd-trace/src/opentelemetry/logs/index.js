'use strict'

/**
 * @fileoverview OpenTelemetry Logs Implementation for dd-trace-js
 *
 * This module provides OpenTelemetry logs functionality for dd-trace-js.
 *
 * VERSION SUPPORT:
 * - OTLP Protocol: v1.7.0
 * - Protobuf Definitions: v1.7.0 (vendored from opentelemetry-proto)
 * - Other versions are not supported
 *
 * TESTING:
 * Run the OpenTelemetry logs tests with:
 * npx mocha packages/dd-trace/test/opentelemetry/logs.spec.js --timeout 30000
 *
 * NOTE: The official @opentelemetry/sdk-logs and @opentelemetry/otlp-transformer
 * packages are tightly coupled to the OpenTelemetry SDK and require @opentelemetry/sdk-logs
 * as a dependency. To avoid pulling in the full SDK, we provide our own implementation
 * that is heavily inspired by the existing OpenTelemetry prior art.
 *
 * Reference implementation (heavily inspired by):
 * - https://github.com/open-telemetry/opentelemetry-js/tree/v2.1.0/experimental/packages/sdk-logs
 * - https://github.com/open-telemetry/opentelemetry-js/tree/v2.1.0/experimental/packages/otlp-transformer
 * - https://github.com/open-telemetry/opentelemetry-proto/tree/v1.7.0
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
