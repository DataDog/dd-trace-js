'use strict'

const dc = require('dc-polyfill')
const log = require('../../dd-trace/src/log')
const shimmer = require('../../datadog-shimmer')
const {
  addHook,
} = require('./helpers/instrument')

const azureFunctionsChannel = dc.tracingChannel('datadog:azure:functions:invoke')

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

  return azureFunction
})

// The http methods are overloaded so we need to check which type of argument was passed in order to wrap the handler
// The arguments are either an object with a handler property or the handler function itself
function wrapHandler (method) {
  log.debug('hi from Olivier')
  return function (name, arg) {
    log.debug('hi again from Olivier')
    // check if this is either a handlerOptions or the handler itself
    if (arg !== null && typeof arg === 'object' && arg.hasOwnProperty('handler')) {
      // if this is a handlerOptions: first, assign to a variable options
      const options = arg

      // then, access the handler within that options. trace that handler using a
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
