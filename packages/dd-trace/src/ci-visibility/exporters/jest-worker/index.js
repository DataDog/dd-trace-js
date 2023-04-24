'use strict'

const Writer = require('./writer')
const {
  JEST_WORKER_COVERAGE_PAYLOAD_CODE,
  JEST_WORKER_TRACE_PAYLOAD_CODE
} = require('../../../plugins/util/test')

/**
 * Lightweight exporter whose writers only do simple JSON serialization
 * of trace and coverage payloads, which they send to the jest main process.
 */
class JestWorkerCiVisibilityExporter {
  constructor () {
    this._writer = new Writer(JEST_WORKER_TRACE_PAYLOAD_CODE)
    this._coverageWriter = new Writer(JEST_WORKER_COVERAGE_PAYLOAD_CODE)
  }

  export (payload) {
    this._writer.append(payload)
  }

  exportCoverage (formattedCoverage) {
    this._coverageWriter.append(formattedCoverage)
  }

  flush () {
    this._writer.flush()
    this._coverageWriter.flush()
  }
}

module.exports = JestWorkerCiVisibilityExporter
