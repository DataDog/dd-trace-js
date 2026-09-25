'use strict'

const { EventEmitter } = require('node:events')

const HANDLER_STREAMING = Symbol.for('aws.lambda.runtime.handler.streaming')
const STREAM_RESPONSE = 'response'

function noop () {}

/**
 * Converts callback, promise, synchronous, and response-streaming Lambda handlers to one promise-returning shape.
 *
 * @param {Function} handler Customer Lambda handler.
 * @returns {Function} Promise-returning handler.
 */
function promisifiedHandler (handler) {
  if (handler[HANDLER_STREAMING] === STREAM_RESPONSE) {
    return function responseStreamHandler (...args) {
      // A synchronous throw has to become a rejection, as it does for buffered handlers. Letting it
      // escape makes tracingChannel.tracePromise skip asyncStart/asyncEnd, which leaves the
      // invocation span unfinished (never exported) and the impending-timeout timer armed to fire
      // against a later invocation in the same warm container.
      try {
        return Promise.resolve(handler.apply(this, args))
      } catch (error) {
        return Promise.reject(error)
      }
    }
  }

  return function bufferedHandler (...args) {
    const contextIndex = findContextIndex(args)
    const context = contextIndex === -1 ? {} : args[contextIndex]
    let modifiedCallback = noop
    let modifiedLegacyDoneCallback = noop
    let modifiedLegacySucceedCallback = noop
    let modifiedLegacyFailCallback = noop

    const callbackPromise = new Promise(function (resolve, reject) {
      modifiedCallback = function (error, result) {
        if (error !== undefined && error !== null) {
          reject(error)
        } else {
          resolve(result)
        }
      }
      modifiedLegacyDoneCallback = function (error, result) {
        context.callbackWaitsForEmptyEventLoop = false
        if (error !== undefined && error !== null) {
          reject(error)
        } else {
          resolve(result)
        }
      }
      modifiedLegacySucceedCallback = function (result) {
        context.callbackWaitsForEmptyEventLoop = false
        resolve(result)
      }
      modifiedLegacyFailCallback = function (error) {
        context.callbackWaitsForEmptyEventLoop = false
        reject(error)
      }
    })

    context.done = modifiedLegacyDoneCallback
    context.succeed = modifiedLegacySucceedCallback
    context.fail = modifiedLegacyFailCallback

    // Only the handler's declared arity decides whether it completes through the callback, matching
    // the original. The AWS runtime always supplies a callback in the third argument, so treating a
    // supplied callback as proof of callback-style completion would make every synchronous handler
    // wait forever on a callback it never calls.
    const takesCallback = handler.length >= 3 && contextIndex !== 2
    const invocationArgs = [...args]
    const suppliedCallbackIndex = findCallbackIndex(invocationArgs, contextIndex)
    if (suppliedCallbackIndex !== -1) {
      invocationArgs[suppliedCallbackIndex] = modifiedCallback
    } else if (takesCallback) {
      invocationArgs[2] = modifiedCallback
    }

    let result
    try {
      result = handler.apply(this, invocationArgs)
    } catch (error) {
      return Promise.reject(error)
    }
    if (result !== undefined && typeof result?.then === 'function') {
      return Promise.race([callbackPromise, result])
    }
    if (takesCallback || result === undefined) return callbackPromise
    if (looksLikeSideEffectArtifact(result)) return callbackPromise
    return Promise.resolve(result)
  }
}

/**
 * Finds a Lambda context object in the supported argument positions.
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
 * Finds a supplied callback while excluding a function that is itself the Lambda context.
 *
 * @param {unknown[]} args Handler arguments.
 * @param {number} contextIndex Lambda context position.
 */
function findCallbackIndex (args, contextIndex) {
  return contextIndex !== 2 && typeof args[2] === 'function' ? 2 : -1
}

/**
 * Detects common server and emitter artifacts whose real completion arrives through context callbacks.
 *
 * @param {unknown} result Handler return value.
 */
function looksLikeSideEffectArtifact (result) {
  return result !== null && typeof result === 'object' &&
    ((typeof result.listen === 'function' && typeof result.close === 'function') ||
      (typeof result.on === 'function' && typeof result.emit === 'function') ||
      result instanceof EventEmitter ||
      (result.constructor && /Server|Socket|Emitter/i.test(result.constructor.name)))
}

module.exports = {
  HANDLER_STREAMING,
  STREAM_RESPONSE,
  promisifiedHandler,
}
