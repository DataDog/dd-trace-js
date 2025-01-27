'use strict'

const telemetryMetrics = require('../telemetry/metrics')

const debuggerNamespace = telemetryMetrics.manager.namespace('live_debugger')

module.exports = {
  onTelemetryMessage ({ type, metric, value, tags = [] }) {
    debuggerNamespace[type](metric, tags).track(value)
  }
}
