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

    const { runWithInvocationContext, getInstanceId } = require('./helpers/azure-trace-context')
    const {
      getTracer,
      spanAttributes,
      endSpan,
    } = require('./helpers/otel-azure-span')
    const {
      registerOrchestrationSpan,
      unregisterOrchestrationSpan,
    } = require('./helpers/otel-orchestration-registry')

    return runWithInvocationContext(args, 'orchestration-generic', () => {
      const invocationContext = args[1]
      const instanceId = getInstanceId(invocationContext)
      const { getOrchestrationSpan } = require('./helpers/otel-orchestration-registry')
      const existingSpan = getOrchestrationSpan(instanceId)

      if (existingSpan) {
        return handler.apply(this, args)
      }

      return getTracer(TRACER_NAME).startActiveSpan(
        `orchestration ${functionName}`,
        { attributes: spanAttributes(functionName, 'durable-orchestration') },
        async (span) => {
          registerOrchestrationSpan(instanceId, span)
          try {
            const result = await handler.apply(this, args)
            const runtimeStatus = invocationContext?.traceContext?.attributes?.DurableFunctionsRuntimeStatus
            if (runtimeStatus === 'Completed' || runtimeStatus === 'Failed' || runtimeStatus === 'Terminated') {
              const { publishOrchestrationSpanMetaSync } = require('./helpers/otel-orchestration-store')
              publishOrchestrationSpanMetaSync(instanceId, span)
              span.end()
              unregisterOrchestrationSpan(instanceId)
            }
            return result
          } catch (error) {
            endSpan(span, error)
            unregisterOrchestrationSpan(instanceId)
            throw error
          }
        },
      )
    })
  }
}

module.exports = { patchApp }
