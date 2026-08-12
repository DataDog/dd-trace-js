'use strict'

const shimmer = require('../../datadog-shimmer')
const {
  wrapAsyncWithTraceContext,
  wrapSyncWithTraceContext,
} = require('./helpers/otel-azure-span')

const TRACER_NAME = '@azure/durable-functions'

function patchApp (app) {
  shimmer.wrap(app, 'entity', entityWrapper)
  shimmer.wrap(app, 'activity', activityWrapper)
  shimmer.wrap(app, 'orchestration', orchestrationWrapper)
}

function entityWrapper (method) {
  return function (entityName, arg) {
    if (typeof arg === 'function') {
      arguments[1] = shimmer.wrapFunction(
        arg,
        handler => wrapSyncWithTraceContext(
          TRACER_NAME,
          'durable-entity',
          handler,
          entityName,
        ),
      )
    } else if (arg && typeof arg.handler === 'function') {
      shimmer.wrap(arg, 'handler', handler => wrapSyncWithTraceContext(
        TRACER_NAME,
        'durable-entity',
        handler,
        entityName,
        arg.handler.name || undefined,
      ))
    }
    return method.apply(this, arguments)
  }
}

function activityWrapper (method) {
  return function (activityName, activityOptions) {
    if (activityOptions && typeof activityOptions.handler === 'function') {
      // Always wrap activities with the async tracer so parent resolution can read
      // the shared orchestration store (Azure Table) when the activity runs on a
      // different worker than the HTTP trigger or orchestrator.
      shimmer.wrap(activityOptions, 'handler', handler =>
        wrapAsyncWithTraceContext(TRACER_NAME, 'durable-activity', handler, activityName),
      )
    }
    return method.apply(this, arguments)
  }
}

function orchestrationWrapper (method) {
  return function (orchestrationName, handler) {
    arguments[1] = shimmer.wrapFunction(handler, h => wrapOrchestrationHandler(h, orchestrationName))
    return method.apply(this, arguments)
  }
}

function wrapOrchestrationHandler (handler, functionName) {
  return function * (...args) {
    const invocationContext = args[0]
    const { getInstanceId } = require('./helpers/azure-trace-context')
    const {
      completeOrchestrationSpan,
      ensureOrchestrationMeta,
    } = require('./helpers/otel-orchestration-store')
    const { unregisterOrchestrationSpan } = require('./helpers/otel-orchestration-registry')

    const instanceId = getInstanceId(invocationContext)

    if (instanceId) {
      ensureOrchestrationMeta(instanceId, invocationContext, functionName)
    }

    try {
      const gen = handler.apply(this, args)
      let step = gen.next()
      while (!step.done) {
        if (instanceId) {
          unregisterOrchestrationSpan(instanceId)
        }
        const input = yield step.value
        step = gen.next(input)
      }

      if (instanceId) {
        completeOrchestrationSpan(TRACER_NAME, instanceId, invocationContext, functionName)
      }

      return step.value
    } catch (error) {
      if (instanceId) {
        completeOrchestrationSpan(TRACER_NAME, instanceId, invocationContext, functionName, error)
      }
      throw error
    } finally {
      if (instanceId) {
        unregisterOrchestrationSpan(instanceId)
      }
    }
  }
}

module.exports = { patchApp }
