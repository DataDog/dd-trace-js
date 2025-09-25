'use strict'
/**
 * BatchLogRecordProcessor processes log records in batches for efficient export to Datadog Agent.
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
   * @param {OtlpHttpLogExporter} exporter - Log processor for exporting batches to Datadog Agent
   * @param {number} batchTimeout - Timeout in milliseconds for batch processing
   * @param {number} maxExportBatchSize - Maximum number of log records per batch
   * @param {number} maxQueueSize - Maximum number of log records in queue
   * @param {number} exportTimeoutMillis - Timeout for export operations
   */
  constructor (exporter, batchTimeout, maxExportBatchSize, maxQueueSize, exportTimeoutMillis) {
    this._exporter = exporter
    this._batchTimeout = batchTimeout
    this._maxExportBatchSize = maxExportBatchSize
    this._maxQueueSize = maxQueueSize
    this._exportTimeoutMillis = exportTimeoutMillis

    this._logRecords = []
    this._timer = null
    this._shutdownPromise = null
    this._isShutdown = false
  }

  /**
   * Processes a single log record.
   *
   * @param {Object} logRecord - The enriched log record with trace correlation and metadata
   */
  onEmit (logRecord) {
    if (this._isShutdown) {
      return
    }

    // Store the log record (already enriched by Logger.emit)
    this._logRecords.push(logRecord)

    if (this._logRecords.length >= this._maxExportBatchSize) {
      this._export()
    } else if (this._logRecords.length === 1) {
      this._startTimer()
    }
  }

  /**
   * Starts the batch timeout timer.
   * @private
   */
  _startTimer () {
    if (this._timer) {
      return
    }

    this._timer = setTimeout(() => {
      this._export()
    }, this._batchTimeout)
  }

  /**
   * Exports the current batch of log records.
   * @private
   */
  _export () {
    if (this._logRecords.length === 0) {
      return
    }

    const logRecords = this._logRecords.splice(0, this._maxExportBatchSize)
    this._clearTimer()
    this._exporter.export(logRecords, () => {})

    if (this._logRecords.length > 0) {
      this._startTimer()
    }
  }

  /**
   * Clears the batch timeout timer.
   * @private
   */
  _clearTimer () {
    if (this._timer) {
      clearTimeout(this._timer)
      this._timer = null
    }
  }

  /**
   * Forces an immediate flush of all pending log records.
   * @returns {Promise<void>} Promise that resolves when flush is complete
   */
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

  /**
   * Shuts down the processor and exports any remaining log records.
   * @returns {Promise<void>} Promise that resolves when shutdown is complete
   */
  shutdown () {
    if (this._isShutdown) {
      return this._shutdownPromise || Promise.resolve()
    }

    this._isShutdown = true
    this._shutdownPromise = new Promise((resolve) => {
      this._clearTimer()

      this._export()

      const shutdownPromises = this._exporter ? [this._exporter.shutdown()] : []

      Promise.all(shutdownPromises).then(resolve)
    })

    return this._shutdownPromise
  }
}

module.exports = BatchLogRecordProcessor
