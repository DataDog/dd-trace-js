'use strict'

const { workerData } = require('node:worker_threads')

const { GuardrailMetrics } = require('../guardrail-metrics')

// For testing purposes, we allow `workerData` to be undefined and fallback to counters that are never drained
const buffer = workerData?.guardrailMetricsBuffer ?? GuardrailMetrics.createBuffer()

/**
 * The worker's view of the guardrail counters shared with the main thread, which drains them into telemetry.
 *
 * @type {GuardrailMetrics}
 */
module.exports = new GuardrailMetrics(buffer)
