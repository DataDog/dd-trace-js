'use strict'

const {
  JEST_WORKER_COVERAGE_PAYLOAD_CODE,
  JEST_WORKER_TRACE_PAYLOAD_CODE,
  JEST_WORKER_TELEMETRY_PAYLOAD_CODE,
  CUCUMBER_WORKER_TRACE_PAYLOAD_CODE,
  MOCHA_WORKER_TRACE_PAYLOAD_CODE,
  JEST_WORKER_LOGS_PAYLOAD_CODE,
  PLAYWRIGHT_WORKER_TRACE_PAYLOAD_CODE,
  PLAYWRIGHT_WORKER_SCREENSHOT_REQUEST,
  PLAYWRIGHT_WORKER_SCREENSHOT_RESPONSE,
  VITEST_WORKER_TRACE_PAYLOAD_CODE,
  VITEST_WORKER_LOGS_PAYLOAD_CODE,
} = require('../../../plugins/util/test')
const getConfig = require('../../../config')
const { getEnvironmentVariable } = require('../../../config/helper')
const Writer = require('./writer')

let screenshotRequestId = 0

function getInterprocessTraceCode () {
  const { DD_PLAYWRIGHT_WORKER, DD_VITEST_WORKER } = getConfig()
  if (getEnvironmentVariable('JEST_WORKER_ID')) {
    return JEST_WORKER_TRACE_PAYLOAD_CODE
  }
  if (getEnvironmentVariable('CUCUMBER_WORKER_ID')) {
    return CUCUMBER_WORKER_TRACE_PAYLOAD_CODE
  }
  if (getEnvironmentVariable('MOCHA_WORKER_ID')) {
    return MOCHA_WORKER_TRACE_PAYLOAD_CODE
  }
  if (DD_PLAYWRIGHT_WORKER) {
    return PLAYWRIGHT_WORKER_TRACE_PAYLOAD_CODE
  }
  if (getEnvironmentVariable('TINYPOOL_WORKER_ID')) {
    return VITEST_WORKER_TRACE_PAYLOAD_CODE
  }
  if (DD_VITEST_WORKER) {
    return VITEST_WORKER_TRACE_PAYLOAD_CODE
  }
  return null
}

// TODO: make it available with cucumber
function getInterprocessCoverageCode () {
  if (getEnvironmentVariable('JEST_WORKER_ID')) {
    return JEST_WORKER_COVERAGE_PAYLOAD_CODE
  }
  return null
}

function getInterprocessLogsCode () {
  if (getEnvironmentVariable('JEST_WORKER_ID')) {
    return JEST_WORKER_LOGS_PAYLOAD_CODE
  }
  if (getEnvironmentVariable('TINYPOOL_WORKER_ID')) {
    return VITEST_WORKER_LOGS_PAYLOAD_CODE
  }
  if (getConfig().DD_VITEST_WORKER) {
    return VITEST_WORKER_LOGS_PAYLOAD_CODE
  }
  return null
}

function getInterprocessTelemetryCode () {
  if (getEnvironmentVariable('JEST_WORKER_ID')) {
    return JEST_WORKER_TELEMETRY_PAYLOAD_CODE
  }
  return null
}

/**
 * Lightweight exporter whose writers only do simple JSON serialization
 * of trace, coverage and logs payloads, which they send to the test framework's main process.
 * Currently used by Jest, Cucumber and Mocha workers.
 */
class TestWorkerCiVisibilityExporter {
  constructor () {
    const interprocessTraceCode = getInterprocessTraceCode()
    const interprocessCoverageCode = getInterprocessCoverageCode()
    const interprocessLogsCode = getInterprocessLogsCode()
    const interprocessTelemetryCode = getInterprocessTelemetryCode()

    this._writer = new Writer(interprocessTraceCode)
    this._coverageWriter = new Writer(interprocessCoverageCode)
    this._logsWriter = new Writer(interprocessLogsCode)
    // TODO: add support for test workers other than Jest
    if (interprocessTelemetryCode) {
      this._telemetryWriter = new Writer(interprocessTelemetryCode)
      this.exportTelemetry = function (telemetryEvent) {
        this._telemetryWriter.append(telemetryEvent)
      }
    }
  }

  export (payload) {
    this._writer.append(payload)
  }

  exportCoverage (formattedCoverage) {
    this._coverageWriter.append(formattedCoverage)
  }

  exportDiLogs (testEnvironmentMetadata, logMessage) {
    this._logsWriter.append({ testEnvironmentMetadata, logMessage })
  }

  /**
   * Returns whether this worker can request a Playwright test screenshot upload.
   *
   * @returns {boolean}
   */
  canUploadTestScreenshots () {
    const { DD_PLAYWRIGHT_WORKER, testOptimization } = getConfig()
    return Boolean(DD_PLAYWRIGHT_WORKER && testOptimization.DD_TEST_FAILURE_SCREENSHOTS_ENABLED)
  }

  /**
   * Requests a screenshot upload from the Playwright runner process.
   *
   * @param {object} options - Screenshot upload options
   * @param {string} options.filePath - Path to the screenshot file
   * @param {string} options.traceId - Test trace id used as the screenshot key
   * @param {string} options.idempotencyKey - Stable per-artifact key
   * @param {number} options.capturedAtMs - Capture time in epoch milliseconds
   * @param {(error: Error|undefined, uploaded: boolean) => void} callback - Completion callback
   * @returns {void}
   */
  uploadTestScreenshot (options, callback) {
    if (!this.canUploadTestScreenshots() || !process.send) {
      callback(undefined, false)
      return
    }

    const requestId = ++screenshotRequestId
    let isComplete = false
    const finish = (error, uploaded) => {
      if (isComplete) return
      isComplete = true
      process.removeListener('message', onMessage)
      callback(error, uploaded)
    }
    const onMessage = (message) => {
      if (message?.type !== PLAYWRIGHT_WORKER_SCREENSHOT_RESPONSE || message.requestId !== requestId) {
        return
      }
      const error = message.error ? new Error(message.error) : undefined
      finish(error, message.uploaded === true)
    }
    process.on('message', onMessage)

    try {
      process.send({
        type: PLAYWRIGHT_WORKER_SCREENSHOT_REQUEST,
        requestId,
        options,
      }, error => {
        if (error) finish(error, true)
      })
    } catch (error) {
      finish(error, true)
    }
  }

  /**
   * @param {() => void} [onDone]
   */
  flush (onDone) {
    if (!onDone) {
      this._writer.flush()
      this._coverageWriter.flush()
      this._logsWriter.flush()
      if (this._telemetryWriter) {
        this._telemetryWriter.flush()
      }
      return
    }

    let pendingWriters = this._telemetryWriter ? 4 : 3
    const onWriterFlushed = () => {
      pendingWriters--
      if (pendingWriters === 0) onDone()
    }

    this._writer.flush(onWriterFlushed)
    this._coverageWriter.flush(onWriterFlushed)
    this._logsWriter.flush(onWriterFlushed)
    this._telemetryWriter?.flush(onWriterFlushed)
  }
}

module.exports = TestWorkerCiVisibilityExporter
