'use strict'

const dc = require('dc-polyfill')

const {
  HANDLER_STREAMING,
  STREAM_RESPONSE,
  promisifiedHandler,
  copyHandlerMetadata,
  getDataProperty,
} = require('./helpers/lambda-handler')

// Read through the process-global registry so two dd-trace copies (layer + bundled) resolve the
// same marker. The value is the wrapper itself, so a second wrap of the same handler returns the
// instrumented function rather than the raw one.
const WRAPPED = Symbol.for('dd-trace.lambda.wrapped')
const invocationChannel = dc.tracingChannel('datadog:aws-lambda:invoke')

/**
 * Wraps one customer handler with the shared Lambda invocation channel.
 *
 * @param {Function} handler Customer Lambda handler.
 * @param {Record<string, unknown>} [config] Per-handler configuration overrides.
 * @param {Function} [monitor] Monitors the shim adapter for impending timeouts.
 * @returns {Function} Wrapped handler, or the existing wrapper when already marked.
 */
function wrapHandler (handler, config, monitor) {
  if (typeof handler !== 'function') {
    throw new TypeError('AWS Lambda handler must be a function')
  }
  const existing = getWrappedHandler(handler)
  if (existing !== undefined && config?.forceWrap !== true) return existing

  const isResponseStream = getDataProperty(handler, HANDLER_STREAMING) === STREAM_RESPONSE
  const completion = promisifiedHandler(handler)
  const invoke = monitor ? monitor(completion, true) : completion

  function wrappedHandler (...args) {
    const invocationContext = {
      config,
      context: args[isResponseStream ? 2 : 1],
      event: args[0],
      isResponseStream,
      responseStream: isResponseStream ? args[1] : undefined,
    }

    // The shim awaits its startup listeners before calling the adapter. Preserve that boundary so
    // legacy RIC captures native context completion methods before the adapter replaces them.
    return invocationChannel.tracePromise(
      () => Promise.resolve().then(() => Reflect.apply(invoke, this, args)),
      invocationContext
    )
  }

  // Frozen customer handlers cannot carry markers; share their identity through the tracer registry.
  const ddGlobal = globalThis[Symbol.for('dd-trace')] ??= { beforeExitHandlers: new Set() }
  const lambda = ddGlobal.lambda ??= {}
  const wrappers = lambda.wrappers ??= new WeakMap()
  wrappers.set(handler, wrappedHandler)
  wrappers.set(wrappedHandler, wrappedHandler)
  Object.defineProperty(wrappedHandler, WRAPPED, { value: wrappedHandler })
  copyHandlerMetadata(handler, wrappedHandler)

  return wrappedHandler
}

/**
 * Looks up the invocation wrapper, including markers from older tracer copies.
 *
 * Deliberately does not set datadog-lambda-js's `_ddWrapped` property: the released shim treats
 * that property as "already fully instrumented" and returns early, which would suppress its
 * extractors, inferred spans, enhanced metrics, log injection, and cold-start tracing. dd-trace
 * may only claim that marker once it reproduces those behaviors (Phases 2-3).
 *
 * @param {Function} handler Handler whose invocation wrapper is needed.
 * @returns {Function|undefined} Existing invocation wrapper.
 */
function getWrappedHandler (handler) {
  const wrappers = globalThis[Symbol.for('dd-trace')]?.lambda?.wrappers
  return wrappers?.get(handler) || getDataProperty(handler, WRAPPED)
}

module.exports = {
  WRAPPED,
  invocationChannel,
  getWrappedHandler,
  wrapHandler,
}
