'use strict'

const { channel } = require('../../../datadog-instrumentations/src/helpers/instrument')
const { copyHandlerMetadata, getDataProperty } =
  require('../../../datadog-instrumentations/src/helpers/lambda-handler')
const { ERROR_MESSAGE, ERROR_TYPE } = require('../constants')
const log = require('../log')
const { ImpendingTimeout } = require('./runtime/errors')
const { extractContext } = require('./context')

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
  // eslint-disable-next-line eslint-rules/eslint-timer-unref -- AWS Lambda uses Node.js timers.
  timeout.unref()
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
 * @param {boolean} normalized whether a completion adapter owns completion selection.
 * @param {(receiver: object, clear: Function, callbackObserved: boolean) => object} [observe]
 * Optional observer for native completion and event-loop drain; existing shim adapters omit it.
 */
exports.datadog = function datadog (lambdaHandler, normalized = false, observe) {
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
    const contextIndex = args.indexOf(context)
    const callbackObservable = contextIndex !== 2 && typeof args[2] === 'function'
    const observer = observe?.(this, clear, callbackObservable)
    const clearOnHandlerCompletion = (error, result, failed = false) => {
      // Old normalized shim adapters retain their selected-Promise policy. Native forwarding keeps
      // monitoring while the runtime waits for event-loop drain, even if the adapter Promise settles.
      if ((normalized && !observer) || !callbackPending) {
        clear()
        observer?.complete(error, result, failed)
      }
    }
    if (!normalized) {
      for (const name of ['done', 'succeed', 'fail']) {
        wrapCompletion(context, name, clearOnHandlerCompletion, completionMethods)
      }
    }
    // Legacy Lambda runtimes complete idle invocations through this callback instead of the handler's callback.
    const idleCompletion = observer
      ? () => {
          clear()
          observer.complete(undefined, null, false)
        }
      : clear
    wrapCompletion(globalThis, BEFORE_EXIT, idleCompletion, completionMethods)

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
        const clearCallback = observer
          ? () => {
              clear()
              observer.complete(callbackArgs[0], callbackArgs[1], callbackArgs[0] != null)
            }
          : clear
        if (typeof beforeExit !== 'function') clearCallback()
        try {
          const result = Reflect.apply(callback, this, callbackArgs)
          if (!completed) {
            // A successful legacy callback installs a new listener while waiting for event-loop drain.
            const replacement = getDataProperty(globalThis, BEFORE_EXIT)
            if (typeof replacement !== 'function' || replacement === beforeExit ||
                !wrapCompletion(globalThis, BEFORE_EXIT, clearCallback, completionMethods)) clearCallback()
            else {
              callbackPending = true
              observer?.pending()
            }
          }
          return result
        } catch (error) {
          clearCallback()
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
          clearOnHandlerCompletion(undefined, value)
          return value
        }, error => {
          clearOnHandlerCompletion(error, undefined, true)
          throw error
        })
      }
      // Legacy RIC supplies a callback; newer runtimes complete from the return value.
      if (!callbackObservable) clear()
      return result
    } catch (error) {
      clearOnHandlerCompletion(error, undefined, true)
      throw error
    } finally {
      monitoredContexts.delete(context)
    }
  }

  if (normalized) return monitored

  copyHandlerMetadata(lambdaHandler, monitored)
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
