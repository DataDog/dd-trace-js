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
  #logRecords
  #timer
  #batchTimeout
  #maxExportBatchSize

  /**
   * Creates a new BatchLogRecordProcessor instance.
   *
   * @param {OtlpHttpLogExporter} exporter - Log processor for exporting batches to Datadog Agent
   * @param {number} batchTimeout - Timeout in milliseconds for batch processing
   * @param {number} maxExportBatchSize - Maximum number of log records per batch
   */
  constructor (exporter, batchTimeout, maxExportBatchSize) {
    this.exporter = exporter
    this.#batchTimeout = batchTimeout
    this.#maxExportBatchSize = maxExportBatchSize
    this.isShutdown = false
    this.#logRecords = []
    this.#timer = null
  }

  /**
   * Processes a single log record.
   *
   * @param {Object} logRecord - The enriched log record with trace correlation and metadata
   */
  onEmit (logRecord) {
    if (this.isShutdown) {
      return
    }

    // Store the log record (already enriched by Logger.emit)
    this.#logRecords.push(logRecord)

    if (this.#logRecords.length >= this.#maxExportBatchSize) {
      this.#export()
    } else if (this.#logRecords.length === 1) {
      this.#startTimer()
    }
  }

  /**
   * Forces an immediate flush of all pending log records.
   * @returns {Promise<void>} Promise that resolves when flush is complete
   */
  forceFlush () {
    if (!this.isShutdown) {
      this.#export()
    }
    return Promise.resolve()
  }

  /**
   * Shuts down the processor and exports any remaining log records.
   * @returns {Promise<void>} Promise that resolves when shutdown is complete
   */
  shutdown () {
    if (this.isShutdown) {
      return Promise.resolve()
    }

    this.isShutdown = true
    this.#clearTimer()
    this.#export()
    return this.exporter ? this.exporter.shutdown() : Promise.resolve()
  }

  /**
   * Starts the batch timeout timer.
   * @private
   */
  #startTimer () {
    if (this.#timer) {
      return
    }

    this.#timer = setTimeout(() => {
      this.#export()
    }, this.#batchTimeout)
  }

  /**
   * Exports the current batch of log records.
   * @private
   */
  #export () {
    if (this.#logRecords.length === 0) {
      return
    }

    const logRecords = this.#logRecords.splice(0, this.#maxExportBatchSize)
    this.#clearTimer()
    this.exporter.export(logRecords, () => {})

    if (this.#logRecords.length > 0) {
      this.#startTimer()
    }
  }

  /**
   * Clears the batch timeout timer.
   * @private
   */
  #clearTimer () {
    if (this.#timer) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
  }
}

module.exports = BatchLogRecordProcessor
