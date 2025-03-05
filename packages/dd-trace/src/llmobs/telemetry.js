'use strict'

const telemetryMetrics = require('../telemetry/metrics')
const llmobsMetrics = telemetryMetrics.manager.namespace('mlobs')

function incrementLLMObsSpanStartCount (tags, value = 1) {
  llmobsMetrics.count('span.start', tags).inc(value)
}

module.exports = {
  incrementLLMObsSpanStartCount
}
