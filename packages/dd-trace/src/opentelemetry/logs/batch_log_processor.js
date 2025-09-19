'use strict'

/**
 * @fileoverview BatchLogRecordProcessor implementation for OpenTelemetry logs
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
 * - BatchLogRecordProcessor Class: https://open-telemetry.github.io/opentelemetry-js/classes/_opentelemetry_sdk-logs.BatchLogRecordProcessor.html
 * - OpenTelemetry Logs SDK Specification: https://opentelemetry.io/docs/specs/otel/logs/sdk/
 *
 * Reference implementation (heavily inspired by):
 * - https://github.com/open-telemetry/opentelemetry-js/tree/v2.1.0/experimental/packages/sdk-logs
 * - https://github.com/open-telemetry/opentelemetry-proto/tree/v1.7.0
 */

// const { logs } = require('@opentelemetry/api')
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
   * This method is called by the Logger when a log record is emitted.
   * It adds the record to the batch and triggers export if conditions are met.
   *
   * @param {Object} logRecord - The log record to process
   * @param {string} logRecord.severityText - Severity text (e.g., 'INFO', 'ERROR')
   * @param {number} logRecord.severityNumber - Severity number
   * @param {string} logRecord.body - Log message body
   * @param {Object} logRecord.attributes - Log attributes
   * @param {number} logRecord.timestamp - Timestamp in nanoseconds
   */
  onEmit (logRecord) {
    if (this._isShutdown) {
      return
    }

    this._logRecords.push(logRecord)

    // If we've reached the max batch size, export immediately
    if (this._logRecords.length >= this._maxExportBatchSize) {
      this._export()
    } else if (this._logRecords.length === 1) {
      // Start the timer for the first log record
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

    // Process through all registered processors
    for (const processor of this._processors) {
      try {
        processor.export(logRecords, () => {
          // Export callback - could be used for error handling
        })
      } catch (error) {
        log.error('Error in log processor export:', error)
      }
    }

    // If there are more records, start the timer again
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

      // Export any remaining log records
      this._export()

      // Shutdown all processors
      const shutdownPromises = this._processors.map(processor => {
        if (typeof processor.shutdown === 'function') {
          return processor.shutdown()
        }
        return Promise.resolve()
      })

      Promise.all(shutdownPromises).then(() => {
        resolve()
      })
    })

    return this._shutdownPromise
  }
}

module.exports = BatchLogRecordProcessor
