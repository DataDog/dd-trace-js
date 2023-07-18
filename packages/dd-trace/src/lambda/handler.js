'use strict'

const log = require('../log')
const { channel } = require('../../../datadog-instrumentations/src/helpers/instrument')
const { ERROR_MESSAGE, ERROR_TYPE } = require('../constants')
const { ImpendingTimeout } = require('./runtime/errors')

const globalTracer = global._ddtrace
const tracer = globalTracer._tracer
const timeoutChannel = channel('apm:aws:lambda:timeout')
// Always crash the flushes when a message is received
// from this channel.
timeoutChannel.subscribe(_ => {
  crashFlush()
})

let __lambdaTimeout

/**
 * Publishes to the `apm:aws:lambda:timeout` channel when
 * the AWS Lambda run time is about to end.
 *
 * @param {*} context AWS Lambda context object.
 */
function checkTimeout (context) {
  const remainingTimeInMillis = context.getRemainingTimeInMillis()

  let apmFlushDeadline = parseInt(process.env.DD_APM_FLUSH_DEADLINE_MILLISECONDS) || 100
  apmFlushDeadline = apmFlushDeadline < 0 ? 100 : apmFlushDeadline

  __lambdaTimeout = setTimeout(() => {
    timeoutChannel.publish(undefined)
  }, remainingTimeInMillis - apmFlushDeadline)
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
  if (activeSpan !== null) {
    const error = new ImpendingTimeout('Datadog detected an impending timeout')
    activeSpan.addTags({
      [ERROR_MESSAGE]: error.message,
      [ERROR_TYPE]: error.name
    })
  } else {
    log.debug('An impending timeout was reached, but no root span was found. No error will be tagged.')
  }

  tracer._processor.killAll()
  if (activeSpan !== null) {
    activeSpan.finish()
  }
}

/**
 * Extracts the context from the given Lambda handler arguments.
 *
 * @param {*} args any amount of arguments
 * @returns the context, if extraction was succesful.
 */
function extractContext (args) {
  let context = args.length > 1 ? args[1] : undefined
  if (context === undefined || context.getRemainingTimeInMillis === undefined) {
    context = args.length > 2 ? args[2] : undefined
    if (context === undefined || context.getRemainingTimeInMillis === undefined) {
      throw Error('Could not extract context')
    }
  }
  return context
}

/**
 * Patches your AWS Lambda handler function to add some tracing support.
 *
 * @param {*} lambdaHandler a Lambda handler function.
 */
exports.datadog = function datadog (lambdaHandler) {
  return (...args) => {
    const context = extractContext(args)

    checkTimeout(context)
    const result = lambdaHandler.apply(this, args)
    if (result && typeof result.then === 'function') {
      return result.then((res) => {
        clearTimeout(__lambdaTimeout)
        return res
      })
    }
    return result
  }
}
