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

function startChildSpan (tracerName, trigger, functionName, operationName, args, parentContext) {
  return getTracer(tracerName).startSpan(
    `${trigger} ${functionName}`,
    { attributes: spanAttributes(functionName, trigger, operationName) },
    parentContext,
  )
}

function wrapSyncWithTraceContext (tracerName, trigger, handler, functionName, operationName) {
  return function (...args) {
    const { runWithInvocationContext, buildSpanParentContext } = require('./azure-trace-context')
    return runWithInvocationContext(args, trigger, () => {
      const span = startChildSpan(
        tracerName,
        trigger,
        functionName,
        operationName,
        args,
        buildSpanParentContext(args, trigger),
      )
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
    const {
      runWithInvocationContext,
      buildSpanParentContextAsync,
    } = require('./azure-trace-context')

    return runWithInvocationContext(args, trigger, async () => {
      const parentContext = await buildSpanParentContextAsync(args, trigger)
      return getTracer(tracerName).startActiveSpan(
        `${trigger} ${functionName}`,
        { attributes: spanAttributes(functionName, trigger) },
        parentContext,
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
      )
    })
  }
}

module.exports = {
  endSpan,
  getTracer,
  spanAttributes,
  wrapAsyncWithTraceContext,
  wrapSyncWithTraceContext,
}
