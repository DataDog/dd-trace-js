'use strict'

const { AsyncResource } = require('node:async_hooks')

const _tracer = require('../../../../dd-trace')
const { buildLogHolder } = require('../../../src/plugins/log_injection')

const requestContextResource = new AsyncResource('RequestContextResource')
const runWithRequestContext = requestContextResource.bind(async () => {
  await Promise.resolve()

  return buildLogHolder(_tracer)?.dd ?? {}
}, null)

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const sampleResponse = {
  statusCode: 200,
  body: JSON.stringify(
    {
      message: 'hello!',
    },
    null,
    2
  ),
}

const handler = async (_event, _context) => {
  return sampleResponse
}

const asyncResourceHandler = async () => {
  return runWithRequestContext()
}

const capturedAsyncResourceHandler = async () => {
  const invocationSpan = _tracer.scope().active()
  const invocationResource = new AsyncResource('InvocationResource')
  function getActiveSpan () {
    return _tracer.scope().active()
  }
  getActiveSpan.apply = null

  return _tracer.trace('child', () => {
    const childSpan = _tracer.scope().active()
    const capturedSpan = invocationResource.runInAsyncScope(getActiveSpan)

    return {
      capturedSpanId: capturedSpan.context().toSpanId(),
      childSpanId: childSpan.context().toSpanId(),
      invocationSpanId: invocationSpan.context().toSpanId(),
    }
  })
}

const clearedAsyncResourceHandler = async () => {
  return _tracer.scope().activate(null, () => {
    return requestContextResource.runInAsyncScope(() => _tracer.scope().active())
  })
}

const callbackHandler = (_event, _context, callback) => {
  const response = sampleResponse

  callback('', response) // eslint-disable-line n/no-callback-literal
}

const timeoutHandler = async (...args) => {
  await _tracer.trace('self.sleepy', () => {
    return sleep(50)
  })
  return sampleResponse
}

const finishSpansEarlyTimeoutHandler = async (...args) => {
  const response = sampleResponse

  // Mimic closing spans early
  const currentSpan = _tracer.scope().active()
  currentSpan.finish()

  // timeout
  await sleep(50)

  return response
}

const swappedArgsHandler = async (event, _, context) => {
  return sampleResponse
}

const errorHandler = async (_event, _context) => {
  class CustomError extends Error {
    constructor (message) {
      super(message)
      Object.defineProperty(this, 'name', { value: 'CustomError' })
    }
  }
  throw new CustomError('my error')
}

/**
 * Lambda Authorizer handler - only receives event, no context.
 * This is the signature used by API Gateway Lambda Authorizers.
 *
 * @param {import('aws-lambda').APIGatewayAuthorizerEvent} event
 */
const authorizerHandler = async (event) => {
  // Simulate a simple authorizer that returns an IAM policy
  await sleep(1)
  return authorizerHandlerSync(event)
}

/**
 * Synchronous Lambda Authorizer handler - only receives event, no context.
 *
 * @param {import('aws-lambda').APIGatewayAuthorizerEvent} event
 */
const authorizerHandlerSync = (event) => {
  return {
    principalId: 'user123',
    policyDocument: {
      Version: '2012-10-17',
      Statement: [
        {
          Action: 'execute-api:Invoke',
          Effect: 'Allow',
          Resource: event.methodArn || '*',
        },
      ],
    },
  }
}

/**
 * Lambda Authorizer handler that throws an error.
 *
 * @param {import('aws-lambda').APIGatewayAuthorizerEvent} event
 */
const authorizerErrorHandler = async (event) => {
  class AuthorizationError extends Error {
    constructor (message) {
      super(message)
      Object.defineProperty(this, 'name', { value: 'AuthorizationError' })
    }
  }
  throw new AuthorizationError('Unauthorized')
}

module.exports = {
  asyncResourceHandler,
  capturedAsyncResourceHandler,
  clearedAsyncResourceHandler,
  finishSpansEarlyTimeoutHandler,
  handler,
  swappedArgsHandler,
  timeoutHandler,
  errorHandler,
  callbackHandler,
  authorizerHandler,
  authorizerHandlerSync,
  authorizerErrorHandler,
}
