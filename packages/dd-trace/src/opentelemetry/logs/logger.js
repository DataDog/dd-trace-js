'use strict'

/**
 * @fileoverview Logger implementation for OpenTelemetry logs
 *
 * VERSION SUPPORT:
 * - OTLP Protocol: v1.7.0
 * - Protobuf Definitions: v1.7.0 (vendored from opentelemetry-proto)
 * - Other versions are not supported
 *
 * NOTE: The official @opentelemetry/sdk-logs package is tightly coupled to the
 * OpenTelemetry SDK and includes many dependencies we don't need. To avoid
 * pulling in the full SDK, we provide our own implementation that is heavily inspired
 * by the existing OpenTelemetry prior art.
 *
 * This implementation is based on:
 * - Official SDK Documentation: https://open-telemetry.github.io/opentelemetry-js/modules/_opentelemetry_sdk-logs.html
 * - Logger Class: https://open-telemetry.github.io/opentelemetry-js/classes/_opentelemetry_sdk-logs.Logger.html
 * - OpenTelemetry Logs API Specification: https://opentelemetry.io/docs/specs/otel/logs/api/
 *
 * Reference implementation (heavily inspired by):
 * - https://github.com/open-telemetry/opentelemetry-js/tree/v2.1.0/experimental/packages/sdk-logs
 * - https://github.com/open-telemetry/opentelemetry-proto/tree/v1.7.0
 */

const { SeverityNumber } = require('@opentelemetry/api-logs')
const { sanitizeAttributes } = require('@opentelemetry/core')

/**
 * Logger provides methods to emit log records.
 *
 * This implementation follows the OpenTelemetry JavaScript SDK Logger:
 * https://open-telemetry.github.io/opentelemetry-js/classes/_opentelemetry_sdk-logs.Logger.html
 *
 * @class Logger
 */
class Logger {
  /**
   * Creates a new Logger instance.
   *
   * @param {Object} library - Instrumentation library information
   * @param {string} library.name - Library name
   * @param {string} library.version - Library version
   * @param {Object} config - Logger configuration
   * @param {LoggerProvider} loggerProvider - Parent logger provider
   */
  constructor (library, config, loggerProvider) {
    this._config = config
    this._loggerProvider = loggerProvider
    this.instrumentationLibrary = library
  }

  get resource () {
    return this._loggerProvider.resource
  }

  /**
   * Emits a log record.
   *
   * @param {Object} logRecord - The log record to emit
   * @param {string} logRecord.severityText - Severity text (e.g., 'INFO', 'ERROR')
   * @param {number} logRecord.severityNumber - Severity number
   * @param {string} logRecord.body - Log message body
   * @param {Object} [logRecord.attributes] - Log attributes
   * @param {number} [logRecord.timestamp] - Timestamp in nanoseconds
   * @param {string} [logRecord.traceId] - Associated trace ID
   * @param {string} [logRecord.spanId] - Associated span ID
   */
  emit (logRecord) {
    if (this._loggerProvider._isShutdown) {
      return
    }

    const processor = this._loggerProvider.getActiveLogRecordProcessor()
    if (!processor) {
      return
    }

    // Sanitize attributes to ensure they conform to OpenTelemetry spec
    if (logRecord.attributes) {
      logRecord.attributes = sanitizeAttributes(logRecord.attributes)
    }

    // Add instrumentation library information
    logRecord.instrumentationLibrary = this.instrumentationLibrary

    processor.onEmit(logRecord)
  }

  // Convenience methods for common log levels
  debug (message, attributes = {}) {
    this.emit({
      severityText: 'DEBUG',
      severityNumber: SeverityNumber.DEBUG,
      body: message,
      attributes,
      timestamp: Date.now() * 1_000_000 // Convert to nanoseconds
    })
  }

  info (message, attributes = {}) {
    this.emit({
      severityText: 'INFO',
      severityNumber: SeverityNumber.INFO,
      body: message,
      attributes,
      timestamp: Date.now() * 1_000_000
    })
  }

  warn (message, attributes = {}) {
    this.emit({
      severityText: 'WARN',
      severityNumber: SeverityNumber.WARN,
      body: message,
      attributes,
      timestamp: Date.now() * 1_000_000
    })
  }

  error (message, attributes = {}) {
    this.emit({
      severityText: 'ERROR',
      severityNumber: SeverityNumber.ERROR,
      body: message,
      attributes,
      timestamp: Date.now() * 1_000_000
    })
  }

  fatal (message, attributes = {}) {
    this.emit({
      severityText: 'FATAL',
      severityNumber: SeverityNumber.FATAL,
      body: message,
      attributes,
      timestamp: Date.now() * 1_000_000
    })
  }
}

module.exports = Logger
