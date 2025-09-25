'use strict'
const { logs } = require('@opentelemetry/api-logs')
const Logger = require('./logger')
const log = require('../../log')

/**
 * @typedef {import('@opentelemetry/resources').Resource} Resource
 * @typedef {import('@opentelemetry/api-logs').Logger} Logger
 * @typedef {import('./batch_log_processor')} BatchLogRecordProcessor
 */

/**
 * LoggerProvider is the main entry point for creating loggers with a single processor for Datadog Agent export.
 *
 * This implementation follows the OpenTelemetry JavaScript API LoggerProvider interface:
 * https://github.com/open-telemetry/opentelemetry-js/blob/a7a36499f70f25201949aeabb84c5fd4ca80e860/experimental/packages/api-logs/src/types/LoggerProvider.ts
 *
 * @class LoggerProvider
 * @implements {import('@opentelemetry/api-logs').LoggerProvider}
 */
class LoggerProvider {
  /**
   * Creates a new LoggerProvider instance with a single processor for Datadog Agent export.
   *
   * @param {Object} [options] - LoggerProvider options
   * @param {Resource} [options.resource] - Resource attributes
   * @param {BatchLogRecordProcessor} [options.processor] - Single LogRecordProcessor instance for
   *   exporting logs to Datadog Agent
   */
  constructor (options = {}) {
    this.resource = options.resource
    this._processor = options.processor
    this._loggers = new Map()
    this._isShutdown = false
  }

  /**
   * Gets or creates a logger instance.
   *
   * @param {string|Object} nameOrOptions - Logger name or options object
   * @param {string} [version] - Logger version (when nameOrOptions is a string)
   * @param {Object} [options] - Additional options (when nameOrOptions is a string)
   * @returns {Logger} Logger instance
   */
  getLogger (nameOrOptions, version, options = {}) {
    if (this._isShutdown) {
      return this._createNoOpLogger()
    }

    let name, loggerOptions
    if (typeof nameOrOptions === 'string') {
      name = nameOrOptions
      loggerOptions = { version, ...options }
    } else {
      name = nameOrOptions.name
      loggerOptions = nameOrOptions
    }

    const loggerVersion = loggerOptions.version || ''
    const key = `${name}@${loggerVersion}`

    if (!this._loggers.has(key)) {
      this._loggers.set(key, new Logger(this, { name, version: loggerVersion }))
    }
    return this._loggers.get(key)
  }

  /**
   * Creates a no-op logger for use when the provider is shutdown.
   * @returns {Logger} A no-op logger instance
   * @private
   */
  _createNoOpLogger () {
    return {
      instrumentationLibrary: {
        name: 'dd-trace-js',
        version: ''
      },
      emit: () => {},
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      fatal: () => {}
    }
  }

  /**
   * Registers this logger provider as the global provider.
   */
  register () {
    if (this._isShutdown) {
      log.warn('Cannot register after shutdown')
      return
    }

    if (!logs.setGlobalLoggerProvider(this)) {
      logs.getLoggerProvider().setDelegate(this)
    }
  }

  /**
   * Forces a flush of all pending log records.
   * @returns {Promise<void>} Promise that resolves when flush is complete
   */
  forceFlush () {
    if (this._isShutdown) {
      return Promise.reject(new Error('LoggerProvider is shutdown'))
    }

    if (!this._processor) {
      return Promise.resolve()
    }

    return this._processor.forceFlush()
  }

  /**
   * Shuts down the logger provider and all associated processors.
   * @returns {Promise<void>} Promise that resolves when shutdown is complete
   */
  shutdown () {
    if (this._isShutdown) {
      return Promise.resolve()
    }

    this._isShutdown = true

    if (!this._processor) {
      return Promise.resolve()
    }

    return this._processor.shutdown()
  }
}

module.exports = LoggerProvider
