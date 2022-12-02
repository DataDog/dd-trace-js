'use strict'

const { ImpendingTimeout } = require('./runtime/errors')

const globalTracer = global._ddtrace
const tracer = globalTracer._tracer
let __lambdaTimeout

/**
 * Calls `crashFlush` when the remaining time is about to end.
 *
 * @param {*} context AWS Lambda context object.
 */
function checkTimeout (context) {
  let remainingTimeInMillis = context.getRemainingTimeInMillis()
  const apmFlushDeadline = parseInt(process.env.DD_APM_FLUSH_DEADLINE)
  if (apmFlushDeadline && apmFlushDeadline <= remainingTimeInMillis) {
    remainingTimeInMillis = apmFlushDeadline
  }

  __lambdaTimeout = setTimeout(() => {
    crashFlush()
  }, remainingTimeInMillis - 50)
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
  const activeSpan = tracer.scope().active()
  const error = new ImpendingTimeout('Datadog detected an impending timeout')
  activeSpan.setTag('error', error)
  tracer._processor.killAll()
  activeSpan.finish()
}

/**
 * Patches your AWS Lambda handler function to add some tracing support.
 *
 * @param {*} lambdaHandler a Lambda handler function.
 */
exports.datadog = function datadog (lambdaHandler) {
  return (...args) => {
    const context = args[1]
    const patched = lambdaHandler.apply(this, args)
    checkTimeout(context)

    if (patched) {
      // clear the timeout as soon as a result is returned
      patched.then((_) => clearTimeout(__lambdaTimeout))
    }
    return patched
  }
}
