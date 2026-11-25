'use strict'

const { getWrappedHandler, wrapHandler } = require('../../../datadog-instrumentations/src/aws-lambda')
const log = require('../log')
const { datadog: monitor } = require('./handler')

/**
 * Reuses a raw timeout monitor, or its invocation wrapper after facade promotion.
 *
 * @param {Function} handler Customer handler.
 * @returns {Function} Monitored handler.
 */
function withTimeoutMonitor (handler) {
  if (typeof handler !== 'function') throw new TypeError('AWS Lambda handler must be a function')
  // Share handler identity across tracer copies without modifying customer functions.
  const ddGlobal = globalThis[Symbol.for('dd-trace')] ??= { beforeExitHandlers: new Set() }
  const lambda = ddGlobal.lambda ??= {}
  const monitors = lambda.monitors ??= new WeakMap()
  const originals = lambda.originals ??= new WeakMap()
  const original = originals.get(handler) || handler
  const wrapped = getWrappedHandler(original)
  if (wrapped) return wrapped
  const existing = monitors.get(original)
  if (existing) return existing
  const monitored = monitor(original)
  monitors.set(original, monitored)
  originals.set(monitored, original)
  return monitored
}

/**
 * Composes invocation scope -> timeout monitor -> selected completion -> customer handler.
 *
 * @param {Function} handler Customer handler or a monitor-only hook wrapper.
 * @param {Record<string, unknown>} [config] Per-handler overrides.
 * @returns {Function} Instrumented handler.
 */
function wrapLambdaHandler (handler, config) {
  // Normalize the original so a hook-first call has the same completion boundary as facade-first.
  // forceWrap(raw) replaces its wrapper; explicitly force-wrapping a span wrapper still nests it.
  const originals = globalThis[Symbol.for('dd-trace')]?.lambda?.originals
  return wrapHandler(originals?.get(handler) || handler, config, monitor, flushMetrics)
}

/** Flushes public metrics without waiting for the transport, matching datadog-lambda-js. */
function flushMetrics () {
  try {
    const tracer = global._ddtrace
    // Keep the public client's lazy getter unused when the function has never emitted metrics.
    const dogstatsd = tracer && Object.getOwnPropertyDescriptor(tracer, 'dogstatsd')?.value
    if (typeof dogstatsd?.flush === 'function') dogstatsd.flush()
  } catch (error) {
    log.debug('Unable to flush Lambda DogStatsD metrics: %s', error)
  }
}

module.exports = { withTimeoutMonitor, wrapLambdaHandler }
