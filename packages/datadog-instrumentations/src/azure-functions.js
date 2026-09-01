'use strict'

const dc = require('dc-polyfill')
const shimmer = require('../../datadog-shimmer')
const {
  addHook,
} = require('./helpers/instrument')

const azureFunctionsChannel = dc.tracingChannel('datadog:azure:functions:invoke')

// Orchestrators register via app.generic; activities/entities use the durable-functions hook.
const azureDurableFunctionsChannel = dc.tracingChannel('datadog:azure:durable-functions:invoke')

const ORCHESTRATION_TRIGGER_TYPE = 'orchestrationTrigger'
const ORCHESTRATOR_COMPLETED_EVENT_TYPE = 13

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

function wrapGeneric (method) {
  return function (name, options) {
    if (options?.trigger?.type === ORCHESTRATION_TRIGGER_TYPE && typeof options.handler === 'function') {
      shimmer.wrap(options, 'handler', handler => traceOrchestrationHandler(handler, name))
    }
    return method.apply(this, arguments)
  }
}

// Span the registered handler (not the generator body), and skip replays.
function traceOrchestrationHandler (handler, functionName) {
  return function (...args) {
    if (!azureDurableFunctionsChannel.hasSubscribers) return handler.apply(this, args)

    const orchestrationBinding = args[0]
    const traceContext = args[1]?.traceContext

    // we do not want to trace if the orchestrator has already completed and is being reactivated
    const history = orchestrationBinding?.history
    const hasPreviousActivation = history?.some(
      event => event.EventType === ORCHESTRATOR_COMPLETED_EVENT_TYPE
    )

    if (hasPreviousActivation) { return handler.apply(this, args) }

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
