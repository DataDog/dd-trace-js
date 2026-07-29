'use strict'

const dc = require('dc-polyfill')
const shimmer = require('../../datadog-shimmer')
const {
  addHook,
} = require('./helpers/instrument')

const azureFunctionsChannel = dc.tracingChannel('datadog:azure:functions:invoke')

// Durable Functions orchestrators are registered through `app.generic`, so they
// are instrumented here rather than in the `durable-functions` hook. Spans are
// described by the azure-durable-functions plugin, which owns this channel.
const azureDurableFunctionsChannel = dc.tracingChannel('datadog:azure:durable-functions:invoke')

const ORCHESTRATION_TRIGGER_TYPE = 'orchestrationTrigger'

addHook({ name: '@azure/functions', versions: ['>=4'], patchDefault: false }, (azureFunction) => {
  const { app } = azureFunction

  // Http triggers
  shimmer.wrap(app, 'deleteRequest', wrapHandler)
  shimmer.wrap(app, 'http', wrapHandler)
  shimmer.wrap(app, 'get', wrapHandler)
  shimmer.wrap(app, 'patch', wrapHandler)
  shimmer.wrap(app, 'post', wrapHandler)
  shimmer.wrap(app, 'put', wrapHandler)

  // Service Bus triggers
  shimmer.wrap(app, 'serviceBusQueue', wrapHandler)
  shimmer.wrap(app, 'serviceBusTopic', wrapHandler)

  // Event Hub triggers
  shimmer.wrap(app, 'eventHub', wrapHandler)

  // CosmosDB triggers
  shimmer.wrap(app, 'cosmosDB', wrapHandler)

  // Durable Functions orchestration triggers
  shimmer.wrap(app, 'generic', wrapGeneric)

  return azureFunction
})

// `durable-functions` registers orchestrators, activities and entities through
// `app.generic`. Activities and entities are wrapped at the `durable-functions`
// API instead, so only orchestration triggers are handled here.
function wrapGeneric (method) {
  return function (name, options) {
    if (options?.trigger?.type === ORCHESTRATION_TRIGGER_TYPE && typeof options.handler === 'function') {
      shimmer.wrap(options, 'handler', handler => traceOrchestrationHandler(handler, name))
    }
    return method.apply(this, arguments)
  }
}

// The registered orchestration handler is the only boundary that reliably starts
// and settles once per orchestrator invocation. The orchestrator body itself is a
// generator that the durable runtime abandons mid-yield whenever the orchestration
// suspends on a pending task, so a span started around the generator would never
// be finished.
function traceOrchestrationHandler (handler, functionName) {
  return function (...args) {
    if (!azureDurableFunctionsChannel.hasSubscribers) return handler.apply(this, args)

    const orchestrationBinding = args[0]

    // Orchestrators replay their entire history on every invocation. Tracing only
    // the invocations that make forward progress keeps replays from duplicating
    // spans, and keeps the tracer off the replay path entirely.
    if (orchestrationBinding?.isReplaying !== false) return handler.apply(this, args)

    const traceContext = args[1]?.traceContext
    return azureDurableFunctionsChannel.tracePromise(
      handler,
      {
        trigger: 'Orchestration',
        functionName,
        instanceId: orchestrationBinding.instanceId,
        traceparent: traceContext?.traceParent,
        tracestate: traceContext?.traceState,
      },
      this, ...args)
  }
}

// The http methods are overloaded so we need to check which type of argument was passed in order to wrap the handler
// The arguments are either an object with a handler property or the handler function itself
function wrapHandler (method) {
  return function (name, arg) {
    if (arg !== null && typeof arg === 'object' && arg.hasOwnProperty('handler')) {
      const options = arg
      shimmer.wrap(options, 'handler', handler => traceHandler(handler, name, method.name))
    } else if (typeof arg === 'function') {
      const handler = arg
      arguments[1] = shimmer.wrapFunction(handler, handler => traceHandler(handler, name, method.name))
    }
    return method.apply(this, arguments)
  }
}

function traceHandler (handler, functionName, methodName) {
  return function (...args) {
    const httpRequest = args[0]
    const invocationContext = args[1]
    return azureFunctionsChannel.tracePromise(
      handler,
      { functionName, httpRequest, invocationContext, methodName },
      this, ...args)
  }
}
