'use strict'

const log = require('../../log')
const { createServerlessDeliveryTracker } = require('../../serverless')

/**
 * @typedef {import('@opentelemetry/api-logs').LogRecord} LogRecord
 * @typedef {import('@opentelemetry/core').InstrumentationScope} InstrumentationScope
 */

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
   * @param {import('./otlp_http_log_exporter')} exporter - Log processor for exporting batches to Datadog Agent
   * @param {number} batchTimeout - Timeout in milliseconds for batch processing
   * @param {number} maxExportBatchSize - Maximum number of log records per batch
   */
  constructor (exporter, batchTimeout, maxExportBatchSize) {
    this.exporter = exporter
    this.#batchTimeout = batchTimeout
    this.#maxExportBatchSize = maxExportBatchSize
    this.#logRecords = []
    this.#timer = null
  }

  /**
   * Processes a single log record.
   *
   * @param {LogRecord} logRecord - The enriched log record with trace correlation and metadata
   * @param {InstrumentationScope} instrumentationScope - The instrumentation library
   */
  onEmit (logRecord, instrumentationScope) {
    // Store the log record (already enriched by Logger.emit)
    logRecord.instrumentationScope = instrumentationScope
    this.#logRecords.push(logRecord)

    if (this.#logRecords.length >= this.#maxExportBatchSize) {
      this.#export()
    } else if (this.#logRecords.length === 1) {
      this.#startTimer()
    }
  }

  /**
   * Forces an immediate flush of all pending log records.
   * @param {Function} [done] Called after all pending log exports complete
   */
  forceFlush (done) {
    this.#clearTimer()

    const deliveryTracker = createServerlessDeliveryTracker()
    if (!deliveryTracker) {
      // Normal processes preserve the existing fire-and-forget batch flush.
      this.#export()
      done?.()
      return
    }

    // Flush only records present at this boundary. New records belong to the
    // later request that produced them and must not extend this lifecycle flush.
    const logRecords = this.#logRecords
    this.#logRecords = []

    // Join exports already active at this boundary before draining this snapshot.
    if (typeof this.exporter.flush === 'function') {
      deliveryTracker.track(complete => this.exporter.flush(complete))
    }

    deliveryTracker.track(complete => {
      const flushNext = () => {
        if (logRecords.length === 0) {
          complete()
          return
        }

        // Drain the boundary snapshot one batch at a time.
        const batch = logRecords.splice(0, this.#maxExportBatchSize)
        try {
          this.exporter.export(batch, flushNext)
        } catch (error) {
          log.error('Error exporting OTLP logs:', error)
          complete()
        }
      }
      flushNext()
    })
    deliveryTracker.waitForIdle(done)
  }

  /**
   * Discards whatever's queued. Used on a MicroVM clone resume, where log records buffered
   * before the snapshot would otherwise export under every clone's identity.
   * @returns {void}
   */
  resetPendingState () {
    this.#logRecords = []
    this.#clearTimer()
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
    if (this.#logRecords.length === 0) return
    const logRecords = this.#logRecords.slice(0, this.#maxExportBatchSize)
    this.#logRecords = this.#logRecords.slice(this.#maxExportBatchSize)

    this.#clearTimer()
    this.exporter.export(logRecords, () => {})
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
