'use strict'

const { EventEmitter } = require('node:events')
const { types: { isProxy } } = require('node:util')

const HANDLER_STREAMING = Symbol.for('aws.lambda.runtime.handler.streaming')
const HANDLER_HIGHWATERMARK = Symbol.for('aws.lambda.runtime.handler.streaming.highWaterMark')
const STREAM_RESPONSE = 'response'

function noop () {}

/**
 * Converts callback, promise, synchronous, and response-streaming Lambda handlers to one promise-returning shape.
 *
 * @param {Function} handler Customer Lambda handler.
 * @returns {Function} Promise-returning handler.
 */
function promisifiedHandler (handler) {
  if (getDataProperty(handler, HANDLER_STREAMING) === STREAM_RESPONSE) {
    return function responseStreamHandler (...args) {
      // A synchronous throw has to become a rejection, as it does for buffered handlers. Letting it
      // escape makes tracingChannel.tracePromise skip asyncStart/asyncEnd, which leaves the
      // invocation span unfinished (never exported) and the impending-timeout timer armed to fire
      // against a later invocation in the same warm container.
      try {
        return Promise.resolve(Reflect.apply(handler, this, args))
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
    const takesCallback = getDataProperty(handler, 'length') >= 3 && contextIndex !== 2
    const invocationArgs = [...args]
    const suppliedCallbackIndex = findCallbackIndex(invocationArgs, contextIndex)
    if (suppliedCallbackIndex !== -1) {
      invocationArgs[suppliedCallbackIndex] = modifiedCallback
    } else if (takesCallback) {
      invocationArgs[2] = modifiedCallback
    }

    let result
    try {
      result = Reflect.apply(handler, this, invocationArgs)
    } catch (error) {
      return Promise.reject(error)
    }
    if (result !== undefined && typeof result?.then === 'function') {
      return Promise.race([callbackPromise, result])
    }
    if (isCallbackCompletion(handler, result, contextIndex)) return callbackPromise
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
 * @param {Function} handler
 * @param {unknown} result
 * @param {number} contextIndex
 */
function isCallbackCompletion (handler, result, contextIndex) {
  if (getDataProperty(handler, HANDLER_STREAMING) === 'response') return false
  if ((getDataProperty(handler, 'length') >= 3 && contextIndex !== 2) || result === undefined) return true
  if (result === null || typeof result !== 'object') return false
  for (let target = result; target !== null && !isProxy(target); target = Object.getPrototypeOf(target)) {
    if (target === EventEmitter.prototype) return true
  }
  if ((typeof getDataProperty(result, 'listen') === 'function' &&
      typeof getDataProperty(result, 'close') === 'function') ||
      (typeof getDataProperty(result, 'on') === 'function' &&
      typeof getDataProperty(result, 'emit') === 'function')) return true
  const name = getDataProperty(getDataProperty(result, 'constructor'), 'name')
  return typeof name === 'string' && /Server|Socket|Emitter/i.test(name)
}

/**
 * Reads metadata without executing application getters or Proxy traps.
 *
 * @param {unknown} target
 * @param {string | symbol} name
 */
function getDataProperty (target, name) {
  if (target === null || (typeof target !== 'object' && typeof target !== 'function')) return
  while (target !== null && !isProxy(target)) {
    const descriptor = Object.getOwnPropertyDescriptor(target, name)
    if (descriptor) return descriptor.value
    target = Object.getPrototypeOf(target)
  }
}

/**
 * Copies data properties without running customer metadata getters or Proxy traps.
 *
 * @param {Function} handler Original handler.
 * @param {Function} wrapped Wrapper to receive safe metadata.
 */
function copyHandlerMetadata (handler, wrapped) {
  // datadog-lambda-js uses arity and the runtime's streaming metadata to choose how to invoke the handler.
  Object.defineProperty(wrapped, 'length', { value: getDataProperty(handler, 'length') ?? 0 })
  for (const name of [HANDLER_STREAMING, HANDLER_HIGHWATERMARK, '_ddWrapped']) {
    const value = getDataProperty(handler, name)
    if (value !== undefined) wrapped[name] = value
  }
  if (!isProxy(handler)) {
    for (const name of Reflect.ownKeys(handler)) {
      if (name === 'arguments' || name === 'caller') continue
      const descriptor = Object.getOwnPropertyDescriptor(handler, name)
      if (!Object.hasOwn(descriptor, 'value')) continue
      const existing = Object.getOwnPropertyDescriptor(wrapped, name)
      if (existing?.configurable === false) {
        // Intrinsic function slots such as prototype cannot change their descriptor shape.
        if (existing.writable) {
          Object.defineProperty(wrapped, name, { value: descriptor.value, writable: descriptor.writable })
        }
      } else {
        Object.defineProperty(wrapped, name, descriptor)
      }
    }
  }
}

module.exports = {
  HANDLER_STREAMING,
  copyHandlerMetadata,
  getDataProperty,
  STREAM_RESPONSE,
  isCallbackCompletion,
  promisifiedHandler,
}
