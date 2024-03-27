const {
  addHook,
  channel
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')
const tracingChannel = require('dc-polyfill').tracingChannel

const CHANNELS = {
  'gateway.request': tracingChannel('apm:apollo:gateway:request'),
  'gateway.plan': tracingChannel('apm:apollo:gateway:plan'),
  'gateway.validate': tracingChannel('apm:apollo:gateway:validate'),
  'gateway.execute': tracingChannel('apm:apollo:gateway:execute'),
  'gateway.fetch': tracingChannel('apm:apollo:gateway:fetch'),
  'gateway.postprocessing': tracingChannel('apm:apollo:gateway:postprocessing')
}

const generalErrorCh = channel('apm:apollo:gateway:general:error')

function wrapExecutor (executor) {
  return function (...args) {
    const channel = CHANNELS['gateway.request']
    const ctx = { requestContext: args[0], gateway: this }

    return channel.tracePromise(executor, ctx, this, ...args)
  }
}

function wrapApolloGateway (ApolloGateway) {
  class ApolloGatewayWrapper extends ApolloGateway {
    constructor (...args) {
      super(...args)
      shimmer.wrap(this, 'executor', wrapExecutor)
    }
  }
  return ApolloGatewayWrapper
}

function wrapRecordExceptions (recordExceptions) {
  return function wrappedRecordExceptions (...args) {
    const errors = args[1]
    // only the last exception in the array of exceptions will be reported on the span,
    // this is mimicking apollo-gateways internal instrumentation
    // TODO: should we consider a mechanism to report all exceptions? since this method aggregates all exceptions
    // where as a span can only have one exception set on it at a time
    generalErrorCh.publish({ error: errors[errors.length - 1] })
    return recordExceptions.apply(this, args)
  }
}

function wrapStartActiveSpan (startActiveSpan) {
  return function (...args) {
    const firstArg = args[0]
    const cb = args[args.length - 1]
    if (typeof firstArg !== 'string' || typeof cb !== 'function') return startActiveSpan.apply(this, args)

    const method = CHANNELS[firstArg]
    let ctx = {}
    if (firstArg === 'gateway.fetch') {
      ctx = { attributes: args[1].attributes }
    }

    switch (firstArg) {
      case 'gateway.plan' :
      case 'gateway.validate': {
        args[args.length - 1] = function (...callbackArgs) {
          return method.traceSync(cb, ctx, this, ...callbackArgs)
        }
        break
      }
      // Patch `executor` instead so the requestContext can be captured.
      case 'gateway.request':
        break
      case 'gateway.execute':
      case 'gateway.postprocessing' :
      case 'gateway.fetch': {
        args[args.length - 1] = function (...callbackArgs) {
          return method.tracePromise(cb, ctx, this, ...callbackArgs)
        }
        break
      }
    }
    return startActiveSpan.apply(this, args)
  }
}

addHook({ name: '@apollo/gateway', file: 'dist/utilities/opentelemetry.js', versions: ['>=2.3.0'] },
  (obj) => {
    const newTracerObj = Object.create(obj.tracer)
    shimmer.wrap(newTracerObj, 'startActiveSpan', wrapStartActiveSpan)
    obj.tracer = newTracerObj
    return obj
  })

addHook({ name: '@apollo/gateway', file: 'dist/utilities/opentelemetry.js', versions: ['>=2.6.0'] },
  (obj) => {
    shimmer.wrap(obj, 'recordExceptions', wrapRecordExceptions)
    return obj
  })

addHook({ name: '@apollo/gateway', versions: ['>=2.3.0'] }, (gateway) => {
  shimmer.wrap(gateway, 'ApolloGateway', wrapApolloGateway)
  return gateway
})
