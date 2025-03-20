'use strict'

const telemetryMetrics = require('../telemetry/metrics')

/** @type {import('../telemetry/metrics').Namespace} */
const llmobsMetrics = telemetryMetrics.manager.namespace('mlobs')

/**
 * Records an LLMObs span start event, incrementing the count by the given value.
 * @param {Record<string, string>} tags - the tags to tag the telemetry event with
 * @param {number} value - how many span start events to record
 */
function recordSpanStart (tags, value = 1) {
  llmobsMetrics.count('span.start', tags).inc(value)
}

module.exports = {
  incrementLLMObsSpanStartCount: recordSpanStart
}
