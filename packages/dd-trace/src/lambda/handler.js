'use strict'

const log = require('../log')
const { channel } = require('../../../datadog-instrumentations/src/helpers/instrument')
const { ERROR_MESSAGE, ERROR_TYPE } = require('../constants')
const { getValueFromEnvSources } = require('../config/helper')
const { ImpendingTimeout } = require('./runtime/errors')
const { extractContext } = require('./context')

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
 * @param {object} context AWS Lambda context object.
 */
function checkTimeout (context) {
  const remainingTimeInMillis = context.getRemainingTimeInMillis()

  let apmFlushDeadline = Number.parseInt(getValueFromEnvSources('DD_APM_FLUSH_DEADLINE_MILLISECONDS')) || 100
  apmFlushDeadline = apmFlushDeadline < 0 ? 100 : apmFlushDeadline

  __lambdaTimeout = setTimeout(() => {
    timeoutChannel.publish()
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
 * Patches your AWS Lambda handler function to add some tracing support.
 *
 * @param {Function} lambdaHandler a Lambda handler function.
 */
exports.datadog = function datadog (lambdaHandler) {
  return (...args) => {
    const context = extractContext(args)

    if (context) {
      checkTimeout(context)
    }

    const result = lambdaHandler.apply(this, args)
    if (result && typeof result.then === 'function') {
      return result.then((res) => {
        clearTimeout(__lambdaTimeout)
        return res
      })
    }
    clearTimeout(__lambdaTimeout)
    return result
  }
}
