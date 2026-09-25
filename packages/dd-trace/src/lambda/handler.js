'use strict'

const dc = require('dc-polyfill')

const { ERROR_MESSAGE, ERROR_TYPE } = require('../constants')
const log = require('../log')
const { WRAPPED, wrapHandler } = require('../../../datadog-instrumentations/src/aws-lambda')
const { HANDLER_STREAMING, isCallbackCompletion } = require('../../../datadog-plugin-aws-lambda/src/handler-utils')
const { extractContext } = require('./context')
const { ImpendingTimeout } = require('./runtime/errors')

// Read through the process-global registry so two dd-trace copies agree, matching the span
// wrapper's marker. Memoizing here is what keeps the composed instrumentation idempotent: without
// it every re-patch hands `wrapHandler` a fresh inner function, its own marker cannot match, and
// the span wrappers stack.
const MONITORED = Symbol.for('dd-trace.lambda.timeout-monitored')

const timeoutChannel = dc.channel('apm:aws:lambda:timeout')
timeoutChannel.subscribe(() => {
  crashFlush()
})

/**
 * Tags the in-flight invocation span with an impending-timeout error, kills the remaining
 * unfinished spans so they are not lost, and finishes the span.
 *
 * Deliberately span-agnostic: it decorates whatever span is active rather than one it created.
 * That is what lets the monitor compose with either owner of the invocation span — the
 * pre-migration datadog-lambda-js wrapper today, the aws-lambda plugin after the migration.
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
 * Arms the impending-timeout guard for one invocation.
 *
 * Read from the tracer config rather than plugin config on purpose: the monitor has to work when
 * the aws-lambda plugin is not creating a span, which is the default while the pre-migration shim
 * still owns the invocation span.
 *
 * @param {object} context AWS Lambda context object.
 */
function armTimeout (context) {
  const apmFlushDeadline = global._ddtrace?._tracer?._config?.DD_APM_FLUSH_DEADLINE_MILLISECONDS
  // The public facade can be used before tracing is initialized, or with tracing disabled.
  if (!Number.isFinite(apmFlushDeadline)) return
  const remainingTimeInMillis = context.getRemainingTimeInMillis()
  if (!Number.isFinite(remainingTimeInMillis)) return

  return setTimeout(() => {
    timeoutChannel.publish()
  }, Math.max(0, remainingTimeInMillis - apmFlushDeadline))
}

/**
 * Wraps a Lambda handler with impending-timeout monitoring, and nothing else.
 *
 * This creates no span. Whoever owns the invocation span wraps *outside* this, so that the span is
 * active when the timer fires and `crashFlush` can find it through the scope. Both eras compose the
 * same way: `shimDatadog(withTimeoutMonitor(handler))` before the migration,
 * `wrapHandler(withTimeoutMonitor(handler))` after it.
 *
 * @param {Function} lambdaHandler a Lambda handler function.
 * @param {boolean} [reuseSpan] Reuse a promoted span wrapper unless explicitly force-wrapping.
 * @returns {Function} The monitored handler.
 */
function withTimeoutMonitor (lambdaHandler, reuseSpan = true) {
  if (typeof lambdaHandler !== 'function') throw new TypeError('AWS Lambda handler must be a function')
  const monitored = lambdaHandler[MONITORED]
  // A monitor-only hook may subsequently be promoted by the facade. Follow that promotion so a
  // later hook neither adds a second span nor puts a timer outside the existing invocation scope.
  if (monitored !== undefined) return (reuseSpan && monitored[WRAPPED]) || monitored

  function timeoutMonitoredHandler (...args) {
    const context = extractContext(args)
    // A handler invoked without a Lambda context has no deadline to guard.
    if (!context) return lambdaHandler.apply(this, args)

    const timer = armTimeout(context)
    if (timer === undefined) return lambdaHandler.apply(this, args)
    // Clearing on *either* outcome matters: the pre-PR3 version only cleared on fulfilment, so a
    // rejected invocation left the timer armed and it fired against a later invocation in the same
    // warm container, calling killAll() on an unrelated trace.
    const restorations = []
    let completed = false
    const clear = () => {
      if (completed) return
      completed = true
      clearTimeout(timer)
      for (const [name, original, wrapped] of restorations) {
        // A reused context may already belong to a later invocation.
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
      restorations.push([name, original, wrapped])
      context[name] = wrapped
    }

    let result
    try {
      result = lambdaHandler.apply(this, args)
    } catch (error) {
      clear()
      throw error
    }
    if (result !== undefined && typeof result?.then === 'function') {
      return result.then(
        (value) => { clear(); return value },
        (error) => { clear(); throw error }
      )
    }
    if (!isCallbackCompletion(lambdaHandler, result, contextIndex)) clear()
    return result
  }

  lambdaHandler[MONITORED] = timeoutMonitoredHandler
  timeoutMonitoredHandler[MONITORED] = timeoutMonitoredHandler
  // The released shim uses declared arity to distinguish callback handlers, and this symbol to
  // choose (event, stream, context). A rest-argument wrapper must not erase either contract.
  Object.defineProperty(timeoutMonitoredHandler, 'length', { value: lambdaHandler.length })
  if (lambdaHandler[HANDLER_STREAMING] !== undefined) {
    timeoutMonitoredHandler[HANDLER_STREAMING] = lambdaHandler[HANDLER_STREAMING]
  }

  return timeoutMonitoredHandler
}

/**
 * Observes completion without changing the caller's callback arguments, receiver, or return value.
 *
 * @param {Function} callback Original callback.
 * @param {Function} clear Invocation-local timer cleanup.
 * @returns {Function} Completion observer.
 */
function onCompletion (callback, clear) {
  return function monitoredCompletion (...args) {
    clear()
    return callback.apply(this, args)
  }
}

/**
 * Common facade/hook composition: span owner outside, timeout monitor inside.
 *
 * @param {Function} handler Customer handler.
 * @param {Record<string, unknown>} [config] Per-handler overrides.
 * @returns {Function} Instrumented handler.
 */
function wrapLambdaHandler (handler, config) {
  // forceWrap(rawHandler) replaces its wrapper, not wraps its previous span wrapper again.
  // An explicitly supplied already-wrapped handler can still be force-wrapped, as before.
  const wrapped = wrapHandler(withTimeoutMonitor(handler, config?.forceWrap !== true), config)
  handler[WRAPPED] = wrapped
  wrapped[MONITORED] = wrapped
  return wrapped
}

exports.withTimeoutMonitor = withTimeoutMonitor
exports.wrapLambdaHandler = wrapLambdaHandler
