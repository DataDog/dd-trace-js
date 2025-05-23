'use strict'

const {
  addHook
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')
const dc = require('dc-polyfill')

const azureFunctionsChannel = dc.tracingChannel('datadog:azure:functions:invoke')

addHook({ name: '@azure/functions', versions: ['>=4'] }, azureFunction => {
  const { app } = azureFunction

  shimmer.wrap(app, 'deleteRequest', wrapHandler)
  shimmer.wrap(app, 'http', wrapHandler)
  shimmer.wrap(app, 'get', wrapHandler)
  shimmer.wrap(app, 'patch', wrapHandler)
  shimmer.wrap(app, 'post', wrapHandler)
  shimmer.wrap(app, 'put', wrapHandler)

  return azureFunction
})

// The http methods are overloaded so we need to check which type of argument was passed in order to wrap the handler
// The arguments are either an object with a handler property or the handler function itself
function wrapHandler (method) {
  return function (name, arg) {
    if (typeof arg === 'object' && arg.hasOwnProperty('handler')) {
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
