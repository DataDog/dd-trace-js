'use strict'

const shimmer = require('../../datadog-shimmer')
const { wrapAsyncWithTraceContext } = require('./helpers/otel-azure-span')

const TRACER_NAME = '@azure/functions'
const ORCHESTRATION_TRIGGER_TYPE = 'orchestrationTrigger'

function patchApp (app) {
  shimmer.wrap(app, 'deleteRequest', wrapHttpHandler)
  shimmer.wrap(app, 'http', wrapHttpHandler)
  shimmer.wrap(app, 'get', wrapHttpHandler)
  shimmer.wrap(app, 'patch', wrapHttpHandler)
  shimmer.wrap(app, 'post', wrapHttpHandler)
  shimmer.wrap(app, 'put', wrapHttpHandler)
  shimmer.wrap(app, 'generic', wrapGeneric)
}

function wrapHttpHandler (method) {
  return function (name, arg) {
    if (arg !== null && typeof arg === 'object' && Object.hasOwn(arg, 'handler')) {
      shimmer.wrap(arg, 'handler', handler => traceHttpHandler(handler, name))
    } else if (typeof arg === 'function') {
      arguments[1] = shimmer.wrapFunction(arg, handler => traceHttpHandler(handler, name))
    }
    return method.apply(this, arguments)
  }
}

function traceHttpHandler (handler, functionName) {
  return wrapAsyncWithTraceContext(TRACER_NAME, 'http', handler, functionName)
}

function wrapGeneric (method) {
  return function (name, options) {
    if (options?.trigger?.type === ORCHESTRATION_TRIGGER_TYPE && typeof options.handler === 'function') {
      shimmer.wrap(options, 'handler', handler => traceGenericOrchestrationHandler(handler, name))
    }
    return method.apply(this, arguments)
  }
}

function traceGenericOrchestrationHandler (handler, functionName) {
  return function (...args) {
    const orchestrationBinding = args[0]
    if (orchestrationBinding?.isReplaying) {
      return handler.apply(this, args)
    }

    const { runWithInvocationContext } = require('./helpers/azure-trace-context')
    const { getTracer, spanAttributes, endSpan } = require('./helpers/otel-azure-span')

    return runWithInvocationContext(args, 'orchestration-generic', () =>
      getTracer(TRACER_NAME).startActiveSpan(
        `orchestration ${functionName}`,
        { attributes: spanAttributes(functionName, 'durable-orchestration') },
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

module.exports = { patchApp }
