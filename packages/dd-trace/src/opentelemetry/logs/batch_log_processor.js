'use strict'

/**
 * @fileoverview BatchLogRecordProcessor implementation for OpenTelemetry logs
 *
 * Custom implementation to avoid pulling in the full OpenTelemetry SDK.
 * Based on OTLP Protocol v1.7.0.
 */

const log = require('../../log')

/**
 * BatchLogRecordProcessor processes log records in batches for efficient export.
 *
 * This implementation follows the OpenTelemetry JavaScript SDK BatchLogRecordProcessor:
 * https://open-telemetry.github.io/opentelemetry-js/classes/_opentelemetry_sdk-logs.BatchLogRecordProcessor.html
 *
 * @class BatchLogRecordProcessor
 */
class BatchLogRecordProcessor {
  /**
   * Creates a new BatchLogRecordProcessor instance.
   *
   * @param {Array} processors - Array of log processors to process batches
   * @param {Object} config - Configuration options
   * @param {number} [config.batchTimeout=5000] - Timeout in milliseconds for batch processing
   * @param {number} [config.maxExportBatchSize=512] - Maximum number of log records per batch
   * @param {number} [config.maxQueueSize=2048] - Maximum number of log records in queue
   * @param {number} [config.exportTimeoutMillis=30000] - Timeout for export operations
   */
  constructor (processors, config) {
    this._processors = processors
    this._config = config
    this._isShutdown = false
    this._batchTimeout = config.batchTimeout || 5000 // 5 seconds default
    this._maxExportBatchSize = config.maxExportBatchSize || 512
    this._maxQueueSize = config.maxQueueSize || 2048
    this._exportTimeoutMillis = config.exportTimeoutMillis || 30_000 // 30 seconds default

    this._logRecords = []
    this._timer = null
    this._shutdownPromise = null
  }

  /**
   * Processes a single log record.
   *
   * @param {Object} logRecord - The log record to process
   */
  onEmit (logRecord) {
    if (this._isShutdown) {
      return
    }

    this._logRecords.push(logRecord)

    if (this._logRecords.length >= this._maxExportBatchSize) {
      this._export()
    } else if (this._logRecords.length === 1) {
      this._startTimer()
    }
  }

  _startTimer () {
    if (this._timer) {
      return
    }

    this._timer = setTimeout(() => {
      this._export()
    }, this._batchTimeout)
  }

  _export () {
    if (this._logRecords.length === 0) {
      return
    }

    const logRecords = this._logRecords.splice(0, this._maxExportBatchSize)
    this._clearTimer()

    for (const processor of this._processors) {
      try {
        processor.export(logRecords, () => {})
      } catch (error) {
        log.error('Error in log processor export:', error)
      }
    }

    if (this._logRecords.length > 0) {
      this._startTimer()
    }
  }

  _clearTimer () {
    if (this._timer) {
      clearTimeout(this._timer)
      this._timer = null
    }
  }

  forceFlush () {
    return new Promise((resolve) => {
      if (this._isShutdown) {
        resolve()
        return
      }

      this._export()
      resolve()
    })
  }

  shutdown () {
    if (this._isShutdown) {
      return this._shutdownPromise || Promise.resolve()
    }

    this._isShutdown = true
    this._shutdownPromise = new Promise((resolve) => {
      this._clearTimer()

      this._export()

      const shutdownPromises = this._processors.map(processor => {
        return typeof processor.shutdown === 'function'
          ? processor.shutdown()
          : Promise.resolve()
      })

      Promise.all(shutdownPromises).then(resolve)
    })

    return this._shutdownPromise
  }
}

module.exports = BatchLogRecordProcessor
