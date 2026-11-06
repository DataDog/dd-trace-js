'use strict'

const dc = require('dc-polyfill')

const { getValueFromEnvSources } = require('../../dd-trace/src/config/helper')
const log = require('../../dd-trace/src/log')

const {
  HANDLER_STREAMING,
  STREAM_RESPONSE,
  invokeHandler,
  copyHandlerMetadata,
  getDataProperty,
} = require('./helpers/lambda-handler')

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
 * @param {Function} [monitor] Monitors selected completion and native event-loop drain.
 * @returns {Function} Wrapped handler, or the existing wrapper when already marked.
 */
function wrapHandler (handler, config, monitor) {
  if (typeof handler !== 'function') {
    throw new TypeError('AWS Lambda handler must be a function')
  }
  const existing = getWrappedHandler(handler)
  if (existing !== undefined && config?.forceWrap !== true) return existing

  const isResponseStream = getDataProperty(handler, HANDLER_STREAMING) === STREAM_RESPONSE
  const completionMode = config?.handlerCompletion ?? getValueFromEnvSources('DD_LAMBDA_HANDLER_COMPLETION')
  const mode = isResponseStream ? 'return' : completionMode
  function completion (...args) {
    return invokeHandler(handler, this.receiver, args, mode, this)
  }
  const invoke = monitor ? monitor(completion, true, observeCompletion) : completion

  function wrappedHandler (...args) {
    const contextIndex = isResponseStream ? 2 : findContextIndex(args)
    const context = contextIndex === -1 ? {} : args[contextIndex]
    const invocationContext = {
      config,
      context,
      receiver: this,
      complete: completeInvocation,
      pending: pendingCallback,
      event: args[0],
      isResponseStream,
      responseStream: isResponseStream ? args[1] : undefined,
    }

    // Equivalent to tracePromise, with a shared completion guard for native callbacks and Promises.
    // Native callbacks may hand control back to AWS synchronously, before a Promise reaction can run.
    return invocationChannel.start.runStores(invocationContext, () => {
      try {
        return Reflect.apply(invoke, invocationContext, args).then(result => {
          if (!invocationContext.waiting) invocationContext.complete(undefined, result, false)
          return result
        }, error => {
          if (!invocationContext.waiting) invocationContext.complete(error, undefined, true)
          throw error
        })
      } catch (error) {
        invocationContext.complete(error, undefined, true)
        throw error
      } finally {
        invocationContext.dispatched = true
        invocationChannel.end.publish(invocationContext)
      }
    })
  }

  wrappers.set(handler, wrappedHandler)
  wrappers.set(wrappedHandler, wrappedHandler)
  Object.defineProperty(wrappedHandler, WRAPPED, { value: wrappedHandler })
  copyHandlerMetadata(handler, wrappedHandler)

  return wrappedHandler
}

/**
 * Connects timeout cleanup to this invocation without giving the monitor span ownership.
 *
 * @param {object} invocation Internal invocation state.
 * @param {Function} clear Timeout cleanup.
 * @param {boolean} callbackObserved Whether the monitor wraps a supplied callback.
 * @returns {object} Completion observer.
 */
function observeCompletion (invocation, clear, callbackObserved) {
  invocation.clearTimeout = clear
  invocation.callbackObserved = callbackObserved
  return invocation
}

function pendingCallback () {
  this.waiting = true
}

/**
 * Publishes selected completion once, before a native completion method can send the response.
 *
 * @param {unknown} error Selected failure.
 * @param {unknown} result Selected response.
 * @param {boolean} failed Whether completion failed, including falsy error values.
 */
function completeInvocation (error, result, failed) {
  // A synchronous callback can finish before RIC reads the context methods for its Promise continuation.
  // Keep the guarded methods installed until dispatch returns, so that continuation cannot deliver twice.
  if (this.dispatched) {
    const restore = this.restore
    this.restore = undefined
    try {
      restore?.()
    } catch (error) {
      log.error('Error restoring Lambda context completion methods: %s', error)
    }
  }
  if (this.completed) return
  this.completed = true
  this.clearTimeout?.()
  if (failed) {
    this.error = error
    invocationChannel.error.publish(this)
  } else {
    this.result = result
  }
  invocationChannel.asyncStart.runStores(this, () => {
    invocationChannel.asyncEnd.publish(this)
  })
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
  return wrappers.get(handler) || getDataProperty(handler, WRAPPED)
}

module.exports = {
  WRAPPED,
  invocationChannel,
  getWrappedHandler,
  wrapHandler,
}
