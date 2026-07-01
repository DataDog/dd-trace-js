'use strict'

const { HTTP_REQUEST_HEADERS } = require('../../../../ext/tags')
const log = require('../log')
const { channel } = require('../../../datadog-instrumentations/src/helpers/instrument')
const { ERROR_MESSAGE, ERROR_TYPE } = require('../constants')
const { ImpendingTimeout } = require('./runtime/errors')
const { extractContext } = require('./context')

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
  const apmFlushDeadline = global._ddtrace._tracer._config.DD_APM_FLUSH_DEADLINE_MILLISECONDS

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

const startInvocationChannel = channel('datadog:lambda:start-invocation')

let parsedHeaderTags = null

function getHeaderTags () {
  if (parsedHeaderTags === null) {
    const raw = global._ddtrace?._tracer?._config?.headerTags
    parsedHeaderTags = Array.isArray(raw) && raw.length > 0
      ? raw.map(h => h.split(':')).map(([key, tag]) => [key.toLowerCase(), tag])
      : []
  }
  return parsedHeaderTags
}

function onStartInvocation ({ span, headers }) {
  if (!span || !headers) return

  for (const [key, tag] of getHeaderTags()) {
    const value = headers[key]
    if (value) span.setTag(tag || `${HTTP_REQUEST_HEADERS}.${key}`, value)
  }
}

startInvocationChannel.subscribe(onStartInvocation)

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
