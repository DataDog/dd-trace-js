'use strict'

const { EventEmitter } = require('node:events')
const { types: { isProxy } } = require('node:util')

const { channel } = require('../../../datadog-instrumentations/src/helpers/instrument')
const { ERROR_MESSAGE, ERROR_TYPE } = require('../constants')
const log = require('../log')
const { ImpendingTimeout } = require('./runtime/errors')
const { extractContext } = require('./context')

const HANDLER_STREAMING = Symbol.for('aws.lambda.runtime.handler.streaming')
const HANDLER_HIGHWATERMARK = Symbol.for('aws.lambda.runtime.handler.streaming.highWaterMark')
const BEFORE_EXIT = Symbol.for('aws.lambda.beforeExit')
const timeoutChannel = channel('apm:aws:lambda:timeout')
const monitoredContexts = new WeakSet()
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

  const timeout = setTimeout(() => {
    timeoutChannel.publish()
  }, Math.max(0, remainingTimeInMillis - apmFlushDeadline))
  try {
    timeout.unref?.()
  } catch (error) {
    clearTimeout(timeout)
    log.error('Error unreferencing Lambda timeout monitor: %s', error)
    return
  }
  return timeout
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
    if (!context || monitoredContexts.has(context)) return Reflect.apply(lambdaHandler, this, args)

    const timeout = checkTimeout(context)
    if (timeout === undefined) return Reflect.apply(lambdaHandler, this, args)

    let completed = false
    let callbackPending = false
    /** @type {Array<[object, string | symbol, Function, Function]>} */
    const completionMethods = []
    const clear = () => {
      if (completed) return
      completed = true
      clearTimeout(timeout)
      for (const [target, name, original, wrapped] of completionMethods) {
        try {
          if (target[name] === wrapped) Reflect.set(target, name, original)
        } catch (error) {
          log.error('Error restoring Lambda completion %s: %s', name, error)
        }
      }
    }
    const clearOnHandlerCompletion = () => {
      // Once a native callback selects event-loop drain, later handler signals are ignored by RIC.
      if (!callbackPending) clear()
    }

    const contextIndex = args.indexOf(context)
    const callbackObservable = contextIndex !== 2 && typeof args[2] === 'function'
    let completionObservable = true
    for (const name of ['done', 'succeed', 'fail']) {
      if (!wrapCompletion(context, name, clearOnHandlerCompletion, completionMethods)) completionObservable = false
    }
    // Legacy Lambda runtimes complete idle invocations through this callback instead of the handler's callback.
    if (!wrapCompletion(globalThis, BEFORE_EXIT, clear, completionMethods)) completionObservable = false
    // Newer runtimes complete from the return value and expose no legacy completion hooks.
    if (completionMethods.length === 0) completionObservable = false

    if (callbackObservable) {
      const callback = args[2]
      const beforeExitObservable = completionMethods.at(-1)?.[1] === BEFORE_EXIT
      let callbackInvoked = false
      args[2] = function (...callbackArgs) {
        if (completed || callbackInvoked) return Reflect.apply(callback, this, callbackArgs)
        callbackInvoked = true
        let beforeExit
        try {
          if (beforeExitObservable && callbackArgs[0] == null && context.callbackWaitsForEmptyEventLoop) {
            beforeExit = getDataProperty(globalThis, BEFORE_EXIT)
          }
        } catch (error) {
          log.error('Error reading Lambda callback completion: %s', error)
        }
        if (typeof beforeExit !== 'function') clear()
        try {
          const result = Reflect.apply(callback, this, callbackArgs)
          if (!completed) {
            // A successful legacy callback installs a new listener while waiting for event-loop drain.
            const replacement = getDataProperty(globalThis, BEFORE_EXIT)
            if (typeof replacement !== 'function' || replacement === beforeExit ||
                !wrapCompletion(globalThis, BEFORE_EXIT, clear, completionMethods)) clear()
            else callbackPending = true
          }
          return result
        } catch (error) {
          clear()
          throw error
        }
      }
    }

    try {
      // The outer completion adapter owns this context during synchronous dispatch to nested wrappers.
      monitoredContexts.add(context)
      const result = Reflect.apply(lambdaHandler, this, args)
      if (result && typeof result.then === 'function') {
        return result.then(value => {
          clearOnHandlerCompletion()
          return value
        }, error => {
          clearOnHandlerCompletion()
          throw error
        })
      }
      // An observed callback can complete later regardless of arity or an incidental return value.
      // Otherwise, retain monitoring only when context/runtime completion is observable and expected.
      if (!callbackObservable &&
          (!completionObservable || !isCallbackCompletion(monitored, result, contextIndex))) clear()
      return result
    } catch (error) {
      clearOnHandlerCompletion()
      throw error
    } finally {
      monitoredContexts.delete(context)
    }
  }

  // datadog-lambda-js uses arity and the runtime's streaming metadata to choose how to invoke the handler.
  Object.defineProperty(monitored, 'length', { value: getDataProperty(lambdaHandler, 'length') ?? 0 })
  for (const name of [HANDLER_STREAMING, HANDLER_HIGHWATERMARK, '_ddWrapped']) {
    const value = getDataProperty(lambdaHandler, name)
    if (value !== undefined) monitored[name] = value
  }
  if (!isProxy(lambdaHandler)) {
    for (const name of Reflect.ownKeys(lambdaHandler)) {
      if (name === 'arguments' || name === 'caller') continue
      const descriptor = Object.getOwnPropertyDescriptor(lambdaHandler, name)
      if (!Object.hasOwn(descriptor, 'value')) continue
      const existing = Object.getOwnPropertyDescriptor(monitored, name)
      if (existing?.configurable === false) {
        // Intrinsic function slots such as prototype cannot change their descriptor shape.
        if (existing.writable) {
          Object.defineProperty(monitored, name, { value: descriptor.value, writable: descriptor.writable })
        }
      } else {
        Object.defineProperty(monitored, name, descriptor)
      }
    }
  }
  return monitored
}

/**
 * @param {object} target
 * @param {string | symbol} name
 * @param {() => void} clear
 * @param {Array<[object, string | symbol, Function, Function]>} completionMethods
 */
function wrapCompletion (target, name, clear, completionMethods) {
  try {
    const original = target[name]
    if (typeof original !== 'function') return true
    const wrapped = onCompletion(original, clear)
    if (!Reflect.set(target, name, wrapped) || target[name] !== wrapped) return false
    completionMethods.push([target, name, original, wrapped])
    return true
  } catch (error) {
    log.error('Error wrapping Lambda completion %s: %s', name, error)
    return false
  }
}

/**
 * @param {Function} callback
 * @param {() => void} clear
 */
function onCompletion (callback, clear) {
  return function (...args) {
    clear()
    return Reflect.apply(callback, this, args)
  }
}

/**
 * @param {Function} handler
 * @param {unknown} result
 * @param {number} contextIndex
 */
function isCallbackCompletion (handler, result, contextIndex) {
  // datadog-lambda-js's unmarked streaming adapter still receives context as its third argument.
  if (contextIndex === 2 || handler[HANDLER_STREAMING] === 'response') return false
  if ((handler.length >= 3 && contextIndex !== 2) || result === undefined) return true
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
