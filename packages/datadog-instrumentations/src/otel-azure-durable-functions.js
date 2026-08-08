'use strict'

const shimmer = require('../../datadog-shimmer')
const {
  endSpan,
  getTracer,
  spanAttributes,
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
      shimmer.wrap(activityOptions, 'handler', handler => {
        const isAsync = handler?.constructor?.name === 'AsyncFunction'
        return isAsync
          ? wrapAsyncWithTraceContext(TRACER_NAME, 'durable-activity', handler, activityName)
          : wrapSyncWithTraceContext(TRACER_NAME, 'durable-activity', handler, activityName)
      })
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
    const { extractContext, getInstanceId } = require('./helpers/azure-trace-context')
    const {
      getOrchestrationSpan,
      registerOrchestrationSpan,
      unregisterOrchestrationSpan,
    } = require('./helpers/otel-orchestration-registry')
    const { publishOrchestrationSpanMetaSync } = require('./helpers/otel-orchestration-store')

    const instanceId = getInstanceId(invocationContext)

    function startOrchestrationSpan () {
      const parentContext = extractContext(invocationContext?.traceContext)
      const span = getTracer(TRACER_NAME).startSpan(
        `orchestration ${functionName}`,
        { attributes: spanAttributes(functionName, 'durable-orchestration') },
        parentContext,
      )
      registerOrchestrationSpan(instanceId, span)
      return span
    }

    function finishOrchestrationSpan (span) {
      if (!span) return
      publishOrchestrationSpanMetaSync(instanceId, span)
      endSpan(span)
      unregisterOrchestrationSpan(instanceId)
    }

    let span = getOrchestrationSpan(instanceId)
    if (!span) {
      span = startOrchestrationSpan()
    }

    try {
      const gen = handler.apply(this, args)
      let step = gen.next()
      while (!step.done) {
        finishOrchestrationSpan(span)
        span = null
        const input = yield step.value
        if (!span) {
          span = startOrchestrationSpan()
        }
        step = gen.next(input)
      }
      finishOrchestrationSpan(span)
      span = null
      return step.value
    } catch (error) {
      finishOrchestrationSpan(span)
      throw error
    }
  }
}

module.exports = { patchApp }
