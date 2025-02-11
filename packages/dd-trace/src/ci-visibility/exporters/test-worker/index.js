'use strict'

const Writer = require('./writer')
const {
  JEST_WORKER_COVERAGE_PAYLOAD_CODE,
  JEST_WORKER_TRACE_PAYLOAD_CODE,
  CUCUMBER_WORKER_TRACE_PAYLOAD_CODE,
  MOCHA_WORKER_TRACE_PAYLOAD_CODE,
  JEST_WORKER_LOGS_PAYLOAD_CODE
} = require('../../../plugins/util/test')

function getInterprocessTraceCode () {
  if (process.env.JEST_WORKER_ID) {
    return JEST_WORKER_TRACE_PAYLOAD_CODE
  }
  if (process.env.CUCUMBER_WORKER_ID) {
    return CUCUMBER_WORKER_TRACE_PAYLOAD_CODE
  }
  if (process.env.MOCHA_WORKER_ID) {
    return MOCHA_WORKER_TRACE_PAYLOAD_CODE
  }
  return null
}

// TODO: make it available with cucumber
function getInterprocessCoverageCode () {
  if (process.env.JEST_WORKER_ID) {
    return JEST_WORKER_COVERAGE_PAYLOAD_CODE
  }
  return null
}

function getInterprocessLogsCode () {
  if (process.env.JEST_WORKER_ID) {
    return JEST_WORKER_LOGS_PAYLOAD_CODE
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

    this._writer = new Writer(interprocessTraceCode)
    this._coverageWriter = new Writer(interprocessCoverageCode)
    this._logsWriter = new Writer(interprocessLogsCode)
  }

  export (payload) {
    this._writer.append(payload)
  }

  exportCoverage (formattedCoverage) {
    this._coverageWriter.append(formattedCoverage)
  }

  exportDiLogs (testConfiguration, logMessage) {
    this._logsWriter.append({ testConfiguration, logMessage })
  }

  flush () {
    this._writer.flush()
    this._coverageWriter.flush()
    this._logsWriter.flush()
  }
}

module.exports = TestWorkerCiVisibilityExporter
