'use strict'

const telemetryMetrics = require('../../telemetry/metrics')

const debuggerNamespace = telemetryMetrics.manager.namespace('debugger')
const threadPausedDistribution = debuggerNamespace.distribution('thread_paused.ms', [])

module.exports = {
  threadPausedMsMetric (ms) {
    threadPausedDistribution.track(ms)
  }
}
