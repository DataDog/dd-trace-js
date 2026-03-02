'use strict'

const dc = require('dc-polyfill')
const shimmer = require('../../datadog-shimmer')

const {
  addHook,
} = require('./helpers/instrument')

/**
 * @type {import('diagnostics_channel').TracingChannel}
 */
const azureDurableFunctionsChannel = dc.tracingChannel('datadog:azure:durable-functions:invoke')

addHook({ name: 'durable-functions', versions: ['>=3'], patchDefault: false }, (df) => {
  const { app } = df

  shimmer.wrap(app, 'entity', entityWrapper)
  shimmer.wrap(app, 'activity', activityHandler)

  return df
})

function entityWrapper (method) {
  return function (entityName, arg) {
    // because this method is overloaded, the second argument can either be an object
    // with the handler or the handler itself, so first we figure which type it is

    if (typeof arg === 'function') {
      // if a function, this is the handler we want to wrap and trace
      arguments[1] = shimmer.wrapFunction(arg, handler => entityHandler(handler, entityName, method.name))
    } else {
      // if an object, access the handler then trace it
      shimmer.wrap(arg, 'handler', handler => entityHandler(handler, entityName, method.name))
    }

    return method.apply(this, arguments)
  }
}

function entityHandler (handler, entityName, methodName) {
  return function () {
    const entityContext = arguments[0]
    return azureDurableFunctionsChannel.traceSync(
      handler,
      { trigger: 'Entity', functionName: entityName, operationName: entityContext?.df?.operationName },
      this, ...arguments)
  }
}

function activityHandler (method) {
  return function (activityName, activityOptions) {
    shimmer.wrap(activityOptions, 'handler', handler => {
      const isAsync =
        handler && handler.constructor && handler.constructor.name === 'AsyncFunction'

      return function () {
        // use tracePromise if this is an async handler. otherwise, use traceSync
        return isAsync
          ? azureDurableFunctionsChannel.tracePromise(
            handler,
            { trigger: 'Activity', functionName: activityName },
            this, ...arguments)
          : azureDurableFunctionsChannel.traceSync(
            handler,
            { trigger: 'Activity', functionName: activityName },
            this, ...arguments)
      }
    })
    return method.apply(this, arguments)
  }
}
