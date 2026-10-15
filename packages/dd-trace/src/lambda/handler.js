'use strict'

const { EventEmitter } = require('node:events')

const { channel } = require('../../../datadog-instrumentations/src/helpers/instrument')
const { ERROR_MESSAGE, ERROR_TYPE } = require('../constants')
const log = require('../log')
const { ImpendingTimeout } = require('./runtime/errors')
const { extractContext } = require('./context')

const HANDLER_STREAMING = Symbol.for('aws.lambda.runtime.handler.streaming')
const timeoutChannel = channel('apm:aws:lambda:timeout')
// Always crash the flushes when a message is received
// from this channel.
timeoutChannel.subscribe(_ => {
  crashFlush()
})

/**
 * Publishes to the `apm:aws:lambda:timeout` channel when
 * the AWS Lambda run time is about to end.
 *
 * @param {object} context AWS Lambda context object.
 */
function checkTimeout (context) {
  const remainingTimeInMillis = context.getRemainingTimeInMillis()
  const apmFlushDeadline = global._ddtrace?._tracer?._config?.DD_APM_FLUSH_DEADLINE_MILLISECONDS
  if (!Number.isFinite(remainingTimeInMillis) || !Number.isFinite(apmFlushDeadline)) return

  return setTimeout(() => {
    timeoutChannel.publish()
  }, Math.max(0, remainingTimeInMillis - apmFlushDeadline))
}

/**
 * Grabs the current span, adds an error for an impending timeout.
 *
 * After that, it calls `killAll` on the tracer processor
 * in order to kill remaining unfinished spans.
 *
 * Once that is done, it finishes the last span.
 */
function crashFlush () {
  const tracer = global._ddtrace._tracer
  const activeSpan = tracer.scope().active()
  if (activeSpan === null) {
    log.debug('An impending timeout was reached, but no root span was found. No error will be tagged.')
  } else {
    const error = new ImpendingTimeout('Datadog detected an impending timeout')
    activeSpan.addTags({
      [ERROR_MESSAGE]: error.message,
      [ERROR_TYPE]: error.name,
    })
  }

  tracer._processor.killAll()
  if (activeSpan !== null) {
    activeSpan.finish()
  }
}

/**
 * Monitors an AWS Lambda handler for impending timeouts without creating a span.
 *
 * @param {Function} lambdaHandler a Lambda handler function.
 */
exports.datadog = function datadog (lambdaHandler) {
  function monitored (...args) {
    const context = extractContext(args)
    if (!context) return lambdaHandler.apply(this, args)

    const timeout = checkTimeout(context)
    if (!timeout) return lambdaHandler.apply(this, args)

    let completed = false
    const contextMethods = []
    const clear = () => {
      if (completed) return
      completed = true
      clearTimeout(timeout)
      for (const [name, original, wrapped] of contextMethods) {
        if (context[name] === wrapped) context[name] = original
      }
    }

    const contextIndex = args.indexOf(context)
    if (contextIndex !== 2 && typeof args[2] === 'function') {
      args[2] = onCompletion(args[2], clear)
    }
    for (const name of ['done', 'succeed', 'fail']) {
      if (typeof context[name] !== 'function') continue
      const original = context[name]
      const wrapped = onCompletion(original, clear)
      contextMethods.push([name, original, wrapped])
      context[name] = wrapped
    }

    try {
      const result = lambdaHandler.apply(this, args)
      if (result && typeof result.then === 'function') {
        return result.then(value => {
          clear()
          return value
        }, error => {
          clear()
          throw error
        })
      }
      // Match the shim's callback/context completion contract, including incidental server returns.
      if (!isCallbackCompletion(lambdaHandler, result, contextIndex)) clear()
      return result
    } catch (error) {
      clear()
      throw error
    }
  }

  // The shim uses arity and the runtime's streaming marker to choose how to invoke the handler.
  Object.defineProperty(monitored, 'length', { value: lambdaHandler.length })
  if (lambdaHandler[HANDLER_STREAMING] !== undefined) {
    monitored[HANDLER_STREAMING] = lambdaHandler[HANDLER_STREAMING]
  }
  return monitored
}

/**
 * @param {Function} callback
 * @param {() => void} clear
 */
function onCompletion (callback, clear) {
  return function (...args) {
    clear()
    return callback.apply(this, args)
  }
}

/**
 * @param {Function} handler
 * @param {unknown} result
 * @param {number} contextIndex
 */
function isCallbackCompletion (handler, result, contextIndex) {
  if (handler[HANDLER_STREAMING] === 'response') return false
  if ((handler.length >= 3 && contextIndex !== 2) || result === undefined) return true
  return result !== null && typeof result === 'object' && (
    (typeof (/** @type {{ listen?: unknown }} */ (result)).listen === 'function' &&
      typeof (/** @type {{ close?: unknown }} */ (result)).close === 'function') ||
    (typeof (/** @type {{ on?: unknown }} */ (result)).on === 'function' &&
      typeof (/** @type {{ emit?: unknown }} */ (result)).emit === 'function') ||
    result instanceof EventEmitter ||
    (result.constructor && /Server|Socket|Emitter/i.test(result.constructor.name))
  )
}
