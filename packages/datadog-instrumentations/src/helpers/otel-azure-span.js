'use strict'

const api = require('@opentelemetry/api')

const TRACER_VERSION = '1.0.0'

function getTracer (tracerName) {
  return api.trace.getTracer(tracerName, TRACER_VERSION)
}

function endSpan (span, error) {
  if (error) {
    span.recordException(error)
    span.setStatus({ code: api.SpanStatusCode.ERROR, message: error.message })
  }
  span.end()
}

function spanAttributes (functionName, trigger, operationName) {
  return {
    'faas.trigger': trigger,
    'faas.name': functionName,
    'code.function': functionName,
    ...(operationName ? { 'durable.operation': operationName } : {}),
  }
}

function wrapSyncWithTraceContext (tracerName, trigger, handler, functionName, operationName) {
  return function (...args) {
    const { runWithInvocationContext } = require('./azure-trace-context')
    return runWithInvocationContext(args, trigger, () => {
      const span = getTracer(tracerName).startSpan(`${trigger} ${functionName}`, {
        attributes: spanAttributes(functionName, trigger, operationName),
      })
      try {
        const result = handler.apply(this, args)
        endSpan(span)
        return result
      } catch (error) {
        endSpan(span, error)
        throw error
      }
    })
  }
}

function wrapAsyncWithTraceContext (tracerName, trigger, handler, functionName) {
  return function (...args) {
    const { runWithInvocationContext } = require('./azure-trace-context')
    return runWithInvocationContext(args, trigger, () =>
      getTracer(tracerName).startActiveSpan(
        `${trigger} ${functionName}`,
        { attributes: spanAttributes(functionName, trigger) },
        async (span) => {
          try {
            const result = await handler.apply(this, args)
            span.end()
            return result
          } catch (error) {
            endSpan(span, error)
            throw error
          }
        },
      ))
  }
}

module.exports = {
  endSpan,
  getTracer,
  spanAttributes,
  wrapAsyncWithTraceContext,
  wrapSyncWithTraceContext,
}
