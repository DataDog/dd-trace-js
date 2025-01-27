'use strict'

const { workerData: { telemetryPort } } = require('node:worker_threads')

module.exports = {
  threadPausedMsMetric (ms) {
    telemetryPort.postMessage({ type: 'gauge', metric: 'thread_paused.ms', value: ms })
  }
}
