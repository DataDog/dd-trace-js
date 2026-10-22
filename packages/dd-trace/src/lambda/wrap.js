'use strict'

const { getWrappedHandler, wrapHandler } = require('../../../datadog-instrumentations/src/aws-lambda')
const { datadog: monitor } = require('./handler')

// Share identity across bundled/layer tracer copies without mutating customer functions.
const monitorsKey = Symbol.for('dd-trace.lambda.timeout-monitors')
const originalsKey = Symbol.for('dd-trace.lambda.monitored-originals')
const monitors = globalThis[monitorsKey] ??= new WeakMap()
const originals = globalThis[originalsKey] ??= new WeakMap()

/**
 * Reuses a raw timeout monitor, or its invocation wrapper after facade promotion.
 *
 * @param {Function} handler Customer handler.
 * @returns {Function} Monitored handler.
 */
function withTimeoutMonitor (handler) {
  if (typeof handler !== 'function') throw new TypeError('AWS Lambda handler must be a function')
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
  return wrapHandler(originals.get(handler) || handler, config, monitor)
}

module.exports = { withTimeoutMonitor, wrapLambdaHandler }
