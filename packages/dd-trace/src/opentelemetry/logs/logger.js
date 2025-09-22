'use strict'

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
   * @param {LoggerProvider} loggerProvider - Parent logger provider
   * @param {Object} [instrumentationLibrary] - Instrumentation library information
   * @param {string} [instrumentationLibrary.name] - Library name (defaults to 'dd-trace-js')
   * @param {string} [instrumentationLibrary.version] - Library version (defaults to tracer version)
   */
  constructor (loggerProvider, instrumentationLibrary) {
    this._loggerProvider = loggerProvider
    this.instrumentationLibrary = {
      name: instrumentationLibrary?.name || 'dd-trace-js',
      version: instrumentationLibrary?.version || require('../../../../../package.json').version
    }
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

    if (!this._loggerProvider._processor) {
      return
    }

    if (logRecord.attributes) {
      logRecord.attributes = sanitizeAttributes(logRecord.attributes)
    }

    logRecord.instrumentationLibrary = this.instrumentationLibrary
    this._loggerProvider._processor.onEmit(logRecord)
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
