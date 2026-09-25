'use strict'

const tracer = require('../../../..')
const { wrapLambdaHandler } = require('./handler')

// The original returns exactly these three keys (datadog-lambda-js
// `src/trace/context/extractor.ts:24-26`). `tracer.inject` would additionally emit the configured
// W3C and baggage carriers, so the surface is pinned rather than passed through: customers forward
// this object to downstream services, and adding or dropping a key is a visible contract change.
const DATADOG_TRACE_HEADERS = [
  'x-datadog-trace-id',
  'x-datadog-parent-id',
  'x-datadog-sampling-priority',
]

/**
 * Wraps an AWS Lambda handler with the dd-trace Lambda invocation lifecycle.
 *
 * @param {Function} handler AWS Lambda handler.
 * @param {Record<string, unknown>} [config] Per-handler Lambda configuration overrides.
 * @returns {Function} The wrapped handler.
 */
function wrap (handler, config) {
  return wrapLambdaHandler(handler, config)
}

/**
 * Returns Datadog propagation headers for the active Lambda invocation span.
 *
 * @returns {Record<string, string>} Trace propagation headers, or an empty object outside an invocation.
 */
function getTraceHeaders () {
  const span = tracer.scope().active()
  if (!span) return {}

  const carrier = {}
  tracer.inject(span, 'text_map', carrier)

  const headers = {}
  for (const name of DATADOG_TRACE_HEADERS) {
    if (carrier[name] !== undefined) headers[name] = carrier[name]
  }
  return headers
}

/**
 * Submits a custom Lambda distribution metric.
 */
function sendDistributionMetric () {
  throw new Error(notImplemented('sendDistributionMetric'))
}

/**
 * Submits a timestamped custom Lambda distribution metric.
 */
function sendDistributionMetricWithDate () {
  throw new Error(notImplemented('sendDistributionMetricWithDate'))
}

/**
 * Renders a handler-load failure (error span + error metric) for a failure the plugin lifecycle
 * cannot observe: the customer module failed during evaluation, so there is no invocation.
 *
 * @param {{ error: Error, functionName: string, startTime: number }} failure Init failure details.
 */
function reportInitFailure (failure) {
  throw new Error(notImplemented('reportInitFailure'))
}

/**
 * Builds the message for a facade entry point whose implementation has not landed yet.
 *
 * The five-function surface is a cross-major contract, so the names are reserved from the first
 * release of the facade. Throwing keeps the gap loud: a silent no-op here would drop customer
 * metrics with no error anywhere, which is the failure mode this migration exists to avoid.
 * The shim's integration lands only after these are implemented, so the throw never ships to a
 * shim user.
 *
 * @param {string} name Facade entry point.
 */
function notImplemented (name) {
  return `dd-trace/lambda ${name}() is not implemented yet: Lambda metrics land with the metrics ` +
    'pipeline (migration PR 12). Keep using datadog-lambda-js for custom metrics until then.'
}

module.exports = {
  getTraceHeaders,
  reportInitFailure,
  sendDistributionMetric,
  sendDistributionMetricWithDate,
  wrap,
}
