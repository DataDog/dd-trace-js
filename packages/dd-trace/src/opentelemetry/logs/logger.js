'use strict'

/**
 * @fileoverview Logger implementation for OpenTelemetry logs
 *
 * Custom implementation to avoid pulling in the full OpenTelemetry SDK.
 * Based on OTLP Protocol v1.7.0.
 */

const { SeverityNumber } = require('@opentelemetry/api-logs')
const { sanitizeAttributes } = require('@opentelemetry/core')

/**
 * Logger provides methods to emit log records.
 *
 * This implementation follows the OpenTelemetry JavaScript API Logger:
 * https://open-telemetry.github.io/opentelemetry-js/interfaces/_opentelemetry_api-logs.Logger.html
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
   */
  emit (logRecord) {
    if (this._loggerProvider._isShutdown) {
      return
    }

    const processor = this._loggerProvider.getActiveLogRecordProcessor()
    if (!processor) {
      return
    }

    if (logRecord.attributes) {
      logRecord.attributes = sanitizeAttributes(logRecord.attributes)
    }

    logRecord.instrumentationLibrary = this.instrumentationLibrary
    processor.onEmit(logRecord)
  }

  debug (message, attributes = {}) {
    this._emitLog('DEBUG', SeverityNumber.DEBUG, message, attributes)
  }

  info (message, attributes = {}) {
    this._emitLog('INFO', SeverityNumber.INFO, message, attributes)
  }

  warn (message, attributes = {}) {
    this._emitLog('WARN', SeverityNumber.WARN, message, attributes)
  }

  error (message, attributes = {}) {
    this._emitLog('ERROR', SeverityNumber.ERROR, message, attributes)
  }

  fatal (message, attributes = {}) {
    this._emitLog('FATAL', SeverityNumber.FATAL, message, attributes)
  }

  _emitLog (severityText, severityNumber, message, attributes) {
    this.emit({
      severityText,
      severityNumber,
      body: message,
      attributes,
      timestamp: Date.now() * 1_000_000
    })
  }
}

module.exports = Logger
