'use strict'

/**
 * @fileoverview LoggerProvider implementation for OpenTelemetry logs
 *
 * Custom implementation to avoid pulling in the full OpenTelemetry SDK.
 * Based on OTLP Protocol v1.7.0.
 */

const { logs } = require('@opentelemetry/api-logs')
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
   * @param {string} name - Logger name
   * @param {string} [version='1.0.0'] - Logger version
   * @param {Object} [options={}] - Additional options
   * @returns {Logger} Logger instance
   */
  getLogger (name, version = '1.0.0', options = {}) {
    if (this._isShutdown) {
      return this._createNoOpLogger()
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

  _createNoOpLogger () {
    return {
      emit: () => {},
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      fatal: () => {}
    }
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
