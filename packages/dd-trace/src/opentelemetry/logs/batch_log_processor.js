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
   * @param {Object} processor - Log processor for exporting batches to Datadog Agent
   * @param {number} batchTimeout - Timeout in milliseconds for batch processing
   * @param {number} maxExportBatchSize - Maximum number of log records per batch
   * @param {number} maxQueueSize - Maximum number of log records in queue
   * @param {number} exportTimeoutMillis - Timeout for export operations
   */
  constructor (processor, batchTimeout, maxExportBatchSize, maxQueueSize, exportTimeoutMillis) {
    this._processor = processor
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
   * @param {Object} logRecord - The log record to process
   * @param {Object} instrumentationLibrary - Instrumentation library information
   * @param {Object} spanContext - Span context containing traceId and spanId
   * @param {string} spanContext.traceId - Trace ID for correlation
   * @param {string} spanContext.spanId - Span ID for correlation
   */
  onEmit (logRecord, instrumentationLibrary, spanContext) {
    if (this._isShutdown) {
      return
    }

    // Store the additional context with the log record
    const enrichedLogRecord = {
      ...logRecord,
      instrumentationLibrary,
      traceId: spanContext?.traceId || '',
      spanId: spanContext?.spanId || ''
    }

    this._logRecords.push(enrichedLogRecord)

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
    this._processor.export(logRecords, () => {})

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

      const shutdownPromises = this._processor ? [this._processor.shutdown()] : []

      Promise.all(shutdownPromises).then(resolve)
    })

    return this._shutdownPromise
  }
}

module.exports = BatchLogRecordProcessor
