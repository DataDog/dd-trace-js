'use strict'
const { logs } = require('@opentelemetry/api-logs')
const { context } = require('@opentelemetry/api')
const Logger = require('./logger')
const log = require('../../log')
const ContextManager = require('../context_manager')

/**
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
  #loggers
  #contextManager

  /**
   * Creates a new LoggerProvider instance with a single processor for Datadog Agent export.
   *
   * @param {Object} [options] - LoggerProvider options
   * @param {BatchLogRecordProcessor} [options.processor] - Single LogRecordProcessor instance for
   *   exporting logs to Datadog Agent
   */
  constructor (options = {}) {
    this.processor = options.processor
    this.#loggers = new Map()
    this.#contextManager = new ContextManager()
    this.isShutdown = false
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
    if (this.isShutdown) {
      return this.#createNoOpLogger()
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
    const loggerSchemaUrl = loggerOptions?.schemaUrl || ''
    const key = `${name}@${loggerVersion}`

    if (!this.#loggers.has(key)) {
      this.#loggers.set(key, new Logger(this, { name, version: loggerVersion, schemaUrl: loggerSchemaUrl }))
    }
    return this.#loggers.get(key)
  }

  /**
   * Registers this logger provider as the global provider.
   */
  register () {
    if (this.isShutdown) {
      log.warn('Cannot register after shutdown')
      return
    }
    // Set context manager, this is required to correlate logs to spans
    context.setGlobalContextManager(this.#contextManager)
    logs.setGlobalLoggerProvider(this)
  }

  /**
   * Forces a flush of all pending log records.
   * @returns {undefined} Promise that resolves when flush is n ssue cncomplete
   */
  forceFlush () {
    if (!this.isShutdown) {
      return this.processor?.forceFlush()
    }
  }

  /**
   * Shuts down the logger provider and all associated processors.
   * @returns {undefined} Promise that resolves when shutdown is complete
   */
  shutdown () {
    if (!this.isShutdown) {
      this.isShutdown = true
    }
  }

  /**
   * Creates a no-op logger for use when the provider is shutdown.
   * @returns {Logger} A no-op logger instance
   * @private
   */
  #createNoOpLogger () {
    return {
      instrumentationScope: {
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
}

module.exports = LoggerProvider
