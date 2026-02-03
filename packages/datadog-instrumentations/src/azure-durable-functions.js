'use strict'

const dc = require('dc-polyfill')

const shimmer = require('../../datadog-shimmer')
const log = require('../../dd-trace/src/log')

const {
  addHook,
} = require('./helpers/instrument')

/**
 * @type {import('diagnostics_channel').TracingChannel}
 */
const azureDurableFunctionsChannel = dc.TracingChannel('datadog:azure:durable-functions:invoke')

addHook({ name: 'durable-functions', versions: ['>=3'], patchDefault: false }, (df) => {
  log.debug('adding durable functions hook')
  // TODO implement v3
  const { app } = df

  shimmer.wrap(app, 'orchestration', wrapOrchestrationHandler)
  shimmer.wrap(app, 'entity', wrapEntityHandler)
  shimmer.wrap(app, 'activity', activityHandler)

  return df
})

function wrapOrchestrationHandler (method) {
  log.debug('in wrap orchestration handler')
  return function (orchestrationName, arg) {
    // argument can either be the handler itself, or options describing the handler
    if (arg !== null && typeof arg === 'object' && arg.hasOwnProperty('handler')) {
      shimmer.wrap(arg, 'handler', handler => orchestrationHandler(handler, orchestrationName, method.name))
    } else if (typeof arg === 'function') {
      shimmer.wrapFunction(arg, handler => orchestrationHandler(handler, orchestrationName, method.name))
    }
    return method.apply(this, arguments)
  }
}

function orchestrationHandler (handler, orchestrationName, methodName) {
  log.debug('in orchestration handler. ochestrationName: ', orchestrationName, 'method name: ', methodName)

  return function () {
    log.debug('in nested orchestration function')

    const orchestrationContext = arguments[0]
    return azureDurableFunctionsChannel.traceSync(
      handler,
      { orchestrationContext, methodName, orchestrationName },
      this, ...arguments)
  }
}

function wrapEntityHandler (method) {
  return function (entityName, arg) {
    if (typeof arg === 'function') {
      shimmer.wrapFunction(arg, handler => entityHandler(handler, entityName, method.name))
    } else {
      shimmer.wrap(arg, 'handler', handler => entityHandler(handler, entityName, method.name))
    }
    return method.apply(this, arguments)
  }
}

function entityHandler (handler, entityName, methodName) {
  return function (...args) {
    const entityContext = args[0]
    return azureDurableFunctionsChannel.traceSync(
      handler,
      { entityContext, entityName, methodName },
      this, ...args)
  }
}

function activityHandler (method) {
  log.debug('in activity handler. method name:', method.name)

  return function (activityName, activityOptions) {
    log.debug('in nested activity handler. activity name:', activityName)

    shimmer.wrap(activityOptions, 'handler', handler => {
      const isAsync =
        handler && handler.constructor && handler.constructor.name === 'AsyncFunction'

      return function (...args) {
        const invocationContext = args[1]

        if (isAsync) {
          return azureDurableFunctionsChannel.tracePromise(
            handler,
            // MAYBE get function name from invocation context
            { activityName, invocationContext, methodName: method.name },
            this, ...args)
        }
        // TODO handler might still return a promise even if not declared as async
        // maybe put everything under trace promise
        return azureDurableFunctionsChannel.traceSync(
          handler,
          { activityName, invocationContext, methodName: method.name },
          this, ...args)
      }
    })
    return method.apply(this, arguments)
  }
}
