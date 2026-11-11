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
 * @param {'auto' | 'return' | 'callback'} [completionMode] Completion policy for buffered handlers.
 * @returns {Function} Promise-returning handler.
 */
function promisifiedHandler (handler, completionMode = 'auto') {
  const mode = getDataProperty(handler, HANDLER_STREAMING) === STREAM_RESPONSE ? 'return' : completionMode
  return function (...args) {
    return invokeHandler(handler, this, args, mode)
  }
}

/**
 * Adapts customer completion while preserving the original receiver and context.
 * The optional invocation owns lifecycle publication and native completion forwarding.
 *
 * @param {Function} handler Customer handler.
 * @param {unknown} receiver Customer receiver.
 * @param {unknown[]} args Customer arguments.
 * @param {'auto' | 'return' | 'callback'} completionMode Selected completion policy.
 * @param {object} [invocation] Internal lifecycle observer.
 * @returns {Promise<unknown>} Selected handler completion.
 */
function invokeHandler (handler, receiver, args, completionMode, invocation) {
  if (completionMode === 'return') {
    try {
      return Promise.resolve(Reflect.apply(handler, receiver, args))
    } catch (error) {
      return Promise.reject(error)
    }
  }

  const contextIndex = findContextIndex(args)
  const context = contextIndex === -1 ? {} : args[contextIndex]
  const suppliedCallbackIndex = findCallbackIndex(args, contextIndex)
  const originalCallback = suppliedCallbackIndex === -1 ? undefined : args[suppliedCallbackIndex]
  const originals = invocation && ['done', 'succeed', 'fail'].map(name => [
    name, Object.getOwnPropertyDescriptor(context, name), getDataProperty(context, name),
  ])
  let callbackSettled = false
  let nativeCompleted = false
  let acceptsCallback = true
  let racePending = false
  /** @type {(() => unknown) | undefined} */
  let pendingNativeCompletion
  let modifiedCallback = noop
  let modifiedLegacyDoneCallback = noop
  let modifiedLegacySucceedCallback = noop
  let modifiedLegacyFailCallback = noop

  const callbackPromise = new Promise(function (resolve, reject) {
    const complete = (error, result, failed, original, self, values, callback = false) => {
      const first = !callbackSettled
      if (first) {
        callbackSettled = true
        if (failed) reject(error)
        else resolve(result)
      }
      if (!invocation) return
      const forward = () => {
        // Return completion can precede an outer wrapper's final result. Ignore late callbacks,
        // but allow context methods to deliver that result through the runtime's Promise continuation.
        if (nativeCompleted || (callback && (!acceptsCallback || invocation.completed))) return
        // The monitor observes a supplied callback, including a runtime's event-loop-drain policy.
        // Context methods and synthetic callbacks finish the lifecycle before native delivery.
        if (first && !(callback && invocation.callbackObserved)) invocation.complete(error, result, failed)
        if (typeof original === 'function') {
          nativeCompleted = true
          return Reflect.apply(original, self, values)
        }
      }
      // A callback can run before the already-settled Promise's race reaction. Deliver only the winner.
      // Hold duplicate context completions too, so they cannot overtake the first pending callback.
      if (racePending) {
        if (first) pendingNativeCompletion = forward
        return
      }
      return forward()
    }
    modifiedCallback = function (error, result) {
      return complete(error, result, error != null, originalCallback, this, arguments, true)
    }
    modifiedLegacyDoneCallback = function (error, result) {
      // Preserve legacy adapter behavior when no native context method is present.
      if (typeof originals?.[0][2] !== 'function') context.callbackWaitsForEmptyEventLoop = false
      return complete(error, result, error != null, originals?.[0][2], this, arguments)
    }
    modifiedLegacySucceedCallback = function (result) {
      if (typeof originals?.[1][2] !== 'function') context.callbackWaitsForEmptyEventLoop = false
      return complete(undefined, result, false, originals?.[1][2], this, arguments)
    }
    modifiedLegacyFailCallback = function (error) {
      if (typeof originals?.[2][2] !== 'function') context.callbackWaitsForEmptyEventLoop = false
      return complete(error, undefined, true, originals?.[2][2], this, arguments)
    }
  })

  context.done = modifiedLegacyDoneCallback
  context.succeed = modifiedLegacySucceedCallback
  context.fail = modifiedLegacyFailCallback
  if (invocation) {
    const replacements = [modifiedLegacyDoneCallback, modifiedLegacySucceedCallback, modifiedLegacyFailCallback]
    invocation.restore = () => {
      for (let index = 0; index < originals.length; index++) {
        const [name, descriptor] = originals[index]
        if (getDataProperty(context, name) !== replacements[index]) continue
        if (descriptor) Object.defineProperty(context, name, descriptor)
        else delete context[name]
      }
    }
  }

  // Explicit callback mode covers rest/default parameters whose arity hides callback intent.
  // A supplied runtime callback alone does not select callback completion in auto mode.
  const takesCallback = (completionMode === 'callback' || getDataProperty(handler, 'length') >= 3) &&
    contextIndex !== 2
  const invocationArgs = [...args]
  if (suppliedCallbackIndex !== -1) invocationArgs[suppliedCallbackIndex] = modifiedCallback
  else if (takesCallback) invocationArgs[2] = modifiedCallback

  let result
  try {
    result = Reflect.apply(handler, receiver, invocationArgs)
    if (result !== undefined && typeof result?.then === 'function') {
      racePending = true
      return new Promise((resolve, reject) => {
        /**
         * @param {boolean} fromCallback Whether the callback/context contender won.
         * @param {boolean} failed Whether the selected completion failed.
         * @param {unknown} value Selected result or failure.
         */
        const settle = (fromCallback, failed, value) => {
          if (!racePending) return
          racePending = false
          acceptsCallback = fromCallback
          const forward = pendingNativeCompletion
          pendingNativeCompletion = undefined
          if (failed) reject(value)
          else resolve(value)
          if (fromCallback) forward?.()
        }
        // Register the original contenders in Promise.race order, without chaining either one first.
        callbackPromise.then(value => settle(true, false, value), error => settle(true, true, error))
        try {
          Promise.resolve(result).then(value => settle(false, false, value), error => settle(false, true, error))
        } catch (error) {
          settle(false, true, error)
        }
      })
    }
  } catch (error) {
    if (callbackSettled) return callbackPromise
    acceptsCallback = false
    // A thrown handler or then getter can leave a callback scheduled after this rejection.
    callbackPromise.catch(noop)
    return Promise.reject(error)
  }
  if (callbackSettled || completionMode === 'callback' ||
      isCallbackCompletion(handler, result, contextIndex)) return callbackPromise
  acceptsCallback = false
  // Only discarded callback Promises need an observer; returned and raced Promises are already consumed.
  callbackPromise.catch(noop)
  return Promise.resolve(result)
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
  invokeHandler,
}
