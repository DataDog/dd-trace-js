'use strict'

const dc = require('dc-polyfill')

const {
  HANDLER_STREAMING,
  STREAM_RESPONSE,
  promisifiedHandler,
} = require('../../datadog-plugin-aws-lambda/src/handler-utils')

// Read through the process-global registry so two dd-trace copies (layer + bundled) resolve the
// same marker. The value is the wrapper itself, so a second wrap of the same handler returns the
// instrumented function rather than the raw one.
const WRAPPED = Symbol.for('dd-trace.lambda.wrapped')
// Customer functions (and wrappers handed back to us) may be frozen. Share weak keys across
// tracer copies without adding properties to those functions or retaining them indefinitely.
const wrappersKey = Symbol.for('dd-trace.lambda.invocation-wrappers')
const wrappers = globalThis[wrappersKey] ??= new WeakMap()
const invocationChannel = dc.tracingChannel('datadog:aws-lambda:invoke')

/**
 * Wraps one customer handler with the shared Lambda invocation channel.
 *
 * @param {Function} handler Customer Lambda handler.
 * @param {Record<string, unknown>} [config] Per-handler configuration overrides.
 * @returns {Function} Wrapped handler, or the existing wrapper when already marked.
 */
function wrapHandler (handler, config) {
  if (typeof handler !== 'function') {
    throw new TypeError('AWS Lambda handler must be a function')
  }
  const existing = getWrappedHandler(handler)
  if (existing !== undefined && config?.forceWrap !== true) return existing

  const isResponseStream = handler[HANDLER_STREAMING] === STREAM_RESPONSE
  const invoke = promisifiedHandler(handler)

  function wrappedHandler (...args) {
    const contextIndex = isResponseStream ? 2 : findContextIndex(args)
    const context = contextIndex === -1 ? {} : args[contextIndex]
    const invocationContext = {
      config,
      context,
      event: args[0],
      isResponseStream,
      responseStream: isResponseStream ? args[1] : undefined,
    }

    return invocationChannel.tracePromise(invoke, invocationContext, this, ...args)
  }

  wrappers.set(handler, wrappedHandler)
  wrappers.set(wrappedHandler, wrappedHandler)
  wrappedHandler[WRAPPED] = wrappedHandler
  if (isResponseStream) wrappedHandler[HANDLER_STREAMING] = STREAM_RESPONSE

  return wrappedHandler
}

/**
 * Finds an AWS Lambda context object without assuming its argument position.
 *
 * @param {unknown[]} args Handler arguments.
 */
function findContextIndex (args) {
  for (let index = 0; index < args.length && index < 3; index++) {
    if (args[index] && typeof args[index].getRemainingTimeInMillis === 'function') return index
  }
  return -1
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
  return wrappers.get(handler) || handler[WRAPPED]
}

module.exports = {
  WRAPPED,
  invocationChannel,
  getWrappedHandler,
  wrapHandler,
}
