'use strict'

const dc = require('dc-polyfill')

const {
  JEST_WORKER_COVERAGE_PAYLOAD_CODE,
  JEST_WORKER_TRACE_PAYLOAD_CODE,
  JEST_WORKER_TELEMETRY_PAYLOAD_CODE,
  CUCUMBER_WORKER_TRACE_PAYLOAD_CODE,
  CUCUMBER_WORKER_TELEMETRY_PAYLOAD_CODE,
  MOCHA_WORKER_LOGS_PAYLOAD_CODE,
  MOCHA_WORKER_TELEMETRY_PAYLOAD_CODE,
  MOCHA_WORKER_TRACE_PAYLOAD_CODE,
  JEST_WORKER_LOGS_PAYLOAD_CODE,
  PLAYWRIGHT_WORKER_TELEMETRY_PAYLOAD_CODE,
  PLAYWRIGHT_WORKER_TRACE_PAYLOAD_CODE,
  VITEST_WORKER_TRACE_PAYLOAD_CODE,
  VITEST_WORKER_COVERAGE_PAYLOAD_CODE,
  VITEST_WORKER_LOGS_PAYLOAD_CODE,
  VITEST_WORKER_TELEMETRY_PAYLOAD_CODE,
} = require('../../../plugins/util/test')
const getConfig = require('../../../config')
const { getEnvironmentVariable } = require('../../../config/helper')
const formatError = require('../../../telemetry/logs/format-error')
const Writer = require('./writer')

const errorLog = dc.channel('datadog:log:error')
let telemetryWriter

errorLog.subscribe((error) => {
  const log = formatError(error)
  if (log) telemetryWriter?.append({ type: 'log', log })
})

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
  if (getEnvironmentVariable('TINYPOOL_WORKER_ID') || getConfig().DD_VITEST_WORKER) {
    return VITEST_WORKER_COVERAGE_PAYLOAD_CODE
  }
  return null
}

function getInterprocessLogsCode () {
  if (getEnvironmentVariable('JEST_WORKER_ID')) {
    return JEST_WORKER_LOGS_PAYLOAD_CODE
  }
  if (getEnvironmentVariable('MOCHA_WORKER_ID') === 'webdriverio') {
    return MOCHA_WORKER_LOGS_PAYLOAD_CODE
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
  if (getEnvironmentVariable('CUCUMBER_WORKER_ID')) {
    return CUCUMBER_WORKER_TELEMETRY_PAYLOAD_CODE
  }
  if (getEnvironmentVariable('MOCHA_WORKER_ID')) {
    return MOCHA_WORKER_TELEMETRY_PAYLOAD_CODE
  }
  const { DD_PLAYWRIGHT_WORKER, DD_VITEST_WORKER } = getConfig()
  if (DD_PLAYWRIGHT_WORKER) {
    return PLAYWRIGHT_WORKER_TELEMETRY_PAYLOAD_CODE
  }
  if (getEnvironmentVariable('TINYPOOL_WORKER_ID') || DD_VITEST_WORKER) {
    return VITEST_WORKER_TELEMETRY_PAYLOAD_CODE
  }
  return null
}

/**
 * Lightweight exporter whose writers only do simple JSON serialization
 * of trace, coverage and logs payloads, which they send to the test framework's main process.
 * Currently used by Jest, Cucumber and Mocha workers.
 */
class TestWorkerCiVisibilityExporter {
  /** @param {import('../../../config/config-base')} [config] */
  constructor (config) {
    const interprocessTraceCode = getInterprocessTraceCode()
    const interprocessCoverageCode = getInterprocessCoverageCode()
    const interprocessLogsCode = getInterprocessLogsCode()
    const interprocessTelemetryCode = getInterprocessTelemetryCode()

    this._writer = new Writer(interprocessTraceCode)
    this._coverageWriter = new Writer(interprocessCoverageCode)
    this._logsWriter = new Writer(interprocessLogsCode)
    if (interprocessTelemetryCode) {
      this._telemetryWriter = new Writer(interprocessTelemetryCode)
      telemetryWriter = config?.telemetry?.DD_TELEMETRY_LOG_COLLECTION_ENABLED === false
        ? undefined
        : this._telemetryWriter
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
   * @param {(error?: Error) => void} [onDone]
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
    let flushError
    const onWriterFlushed = (error) => {
      flushError ||= error
      pendingWriters--
      if (pendingWriters === 0) onDone(flushError)
    }

    this._writer.flush(onWriterFlushed)
    this._coverageWriter.flush(onWriterFlushed)
    this._logsWriter.flush(onWriterFlushed)
    this._telemetryWriter?.flush(onWriterFlushed)
  }
}

module.exports = TestWorkerCiVisibilityExporter
