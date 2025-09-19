'use strict'

/**
 * @fileoverview LoggerProvider implementation for OpenTelemetry logs
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
 * - LoggerProvider Class: https://open-telemetry.github.io/opentelemetry-js/classes/_opentelemetry_sdk-logs.LoggerProvider.html
 * - OpenTelemetry Logs SDK Specification: https://opentelemetry.io/docs/specs/otel/logs/sdk/
 *
 * Reference implementation (heavily inspired by):
 * - https://github.com/open-telemetry/opentelemetry-js/tree/v2.1.0/experimental/packages/sdk-logs
 * - https://github.com/open-telemetry/opentelemetry-proto/tree/v1.7.0
 */

const { logs } = require('@opentelemetry/api-logs')
// const BatchLogProcessor = require('./batch_log_processor')
// const OtlpHttpLogExporter = require('./otlp_http_log_exporter')
const Logger = require('./logger')
const log = require('../../log')

/**
 * LoggerProvider is the main entry point for creating loggers.
 *
 * This implementation follows the OpenTelemetry JavaScript SDK LoggerProvider:
   * https://open-telemetry.github.io/opentelemetry-js/classes/_opentelemetry_sdk-logs.LoggerProvider.html
 *
 * @class LoggerProvider
 */
class LoggerProvider {
  /**
   * Creates a new LoggerProvider instance.
   *
   * @param {Object} [config={}] - Configuration options
   * @param {Object} [config.resource] - Resource attributes
   * @param {Object} [config.resource.attributes] - Resource attribute key-value pairs
   * @param {Array} [config.processors] - Array of LogRecordProcessor instances
   */
  constructor (config = {}) {
    this.config = config
    this.resource = config.resource
    this._processors = config.processors || []
    this._loggers = new Map()
    this._activeProcessor = null
    this._isShutdown = false
  }

  /**
   * Gets or creates a logger instance.
   *
   * @param {string} name - Logger name (typically the instrumentation library name)
   * @param {string} [version='1.0.0'] - Logger version
   * @param {Object} [options={}] - Additional options
   * @returns {Logger} Logger instance
   */
  getLogger (name, version = '1.0.0', options = {}) {
    if (this._isShutdown) {
      // Return a no-op logger when shutdown
      return {
        emit: () => {},
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        fatal: () => {}
      }
    }

    const key = `${name}@${version}`
    if (!this._loggers.has(key)) {
      this._loggers.set(key, new Logger(
        { ...options, name, version },
        this.config,
        this
      ))
    }
    return this._loggers.get(key)
  }

  addLogRecordProcessor (logRecordProcessor) {
    if (this._isShutdown) {
      log.warn('Cannot add log record processor after shutdown')
      return
    }

    this._processors.push(logRecordProcessor)
    this._activeProcessor = logRecordProcessor
  }

  getActiveLogRecordProcessor () {
    return this._activeProcessor
  }

  register (config = {}) {
    if (this._isShutdown) {
      log.warn('Cannot register after shutdown')
      return
    }

    if (!logs.setGlobalLoggerProvider(this)) {
      logs.getLoggerProvider().setDelegate(this)
    }
  }

  forceFlush () {
    if (this._isShutdown) {
      return Promise.reject(new Error('LoggerProvider is shutdown'))
    }

    if (!this._activeProcessor) {
      return Promise.resolve()
    }

    return this._activeProcessor.forceFlush()
  }

  shutdown () {
    if (this._isShutdown) {
      return Promise.resolve()
    }

    this._isShutdown = true

    if (!this._activeProcessor) {
      return Promise.resolve()
    }

    return this._activeProcessor.shutdown()
  }
}

module.exports = LoggerProvider
