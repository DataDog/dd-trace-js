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
    if (typeof arg === 'function') {
      arguments[1] = shimmer.wrapFunction(arg, handler => entityHandler(handler, entityName, method.name))
    } else {
      shimmer.wrap(arg, 'handler', handler => entityHandler(handler, entityName, method.name))
    }
    return method.apply(this, arguments)
  }
}

function entityHandler (handler, entityName, methodName) {
  return function () {
    return azureDurableFunctionsChannel.traceSync(
      handler,
      { trigger: 'Entity', functionName: entityName },
      this, ...arguments)
  }
}

function activityHandler (method) {
  return function (activityName, activityOptions) {
    shimmer.wrap(activityOptions, 'handler', handler => {
      const isAsync =
        handler && handler.constructor && handler.constructor.name === 'AsyncFunction'

      return function () {
        if (isAsync) {
          return azureDurableFunctionsChannel.tracePromise(
            handler,
            { trigger: 'Activity', functionName: activityName },
            this, ...arguments)
        }
        // handler might still return a promise even if not declared as async
        // MAYBE put everything under trace promise
        return azureDurableFunctionsChannel.traceSync(
          handler,
          { trigger: 'Activity', functionName: activityName },
          this, ...arguments)
      }
    })
    return method.apply(this, arguments)
  }
}
