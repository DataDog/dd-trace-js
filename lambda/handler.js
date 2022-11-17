'use strict'

const { Timeout } = require("./runtime/errors")

const globalTracer = global._ddtrace
const tracer = globalTracer._tracer

/**
 * Calls `crashFlush` when the remaining time is about to end.
 *
 * @param {number} remainingTimeInMillis remaining time a Lambda function
 * has until it gets killed.
 */
function checkTimeout (context) {
  let remainingTimeInMillis = context.getRemainingTimeInMillis()
  const apmFlushDeadline = parseInt(process.env.DD_APM_FLUSH_DEADLINE)
  if (apmFlushDeadline && apmFlushDeadline <= remainingTimeInMillis) {
    remainingTimeInMillis = apmFlushDeadline
  }
  setTimeout(() => {
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
  const error = new Timeout('Datadog detected an impending timeout')
  addError(activeSpan, error)
  activeSpan.setTag('error', 1)
  tracer._processor.killAll()
  activeSpan.finish()
}

// Try to use addError from tracer?
function addError (span, error) {
  span.addTags({
    'error.type': error.name,
    'error.msg': error.message,
    'error.stack': error.stack
  })
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

    return patched
  }
}
