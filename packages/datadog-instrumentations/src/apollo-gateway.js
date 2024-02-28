const {
  addHook,
  channel
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')
const tracingChannel = require('dc-polyfill').tracingChannel

const validateCh = tracingChannel('apm:apollo-gateway:validate')
const requestCh = tracingChannel('apm:apollo-gateway:request')
const fetchCh = tracingChannel('apm:apollo-gateway:fetch')
const planCh = tracingChannel('apm:apollo-gateway:plan')
const executeCh = tracingChannel('apm:apollo-gateway:execute')
const postProcessingCh = tracingChannel('apm:apollo-gateway:postprocessing')

const generalErrorCh = channel('apm:apollo-gateway:general:error')
const REQUEST_CTX = {}

function wrapExecutor (executor) {
  return function (...args) {
    REQUEST_CTX.requestContext = args[0]
    REQUEST_CTX.gateway = { ...this }
    return executor.apply(this, args)
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
    if (typeof firstArg !== 'string') return startActiveSpan.apply(this, args)

    const cb = args[args.length - 1]
    switch (firstArg) {
      case 'gateway.request': {
        args[args.length - 1] = function (...callbackArgs) {
          return requestCh.tracePromise(cb, REQUEST_CTX, this, ...callbackArgs)
        }
        break
      }
      case 'gateway.plan' : {
        args[args.length - 1] = function (...callbackArgs) {
          return planCh.traceSync(cb, {}, this, ...callbackArgs)
        }
        break
      }
      case 'gateway.validate': {
        args[args.length - 1] = function (...callbackArgs) {
          return validateCh.traceSync(cb, {}, this, ...callbackArgs)
        }
        break
      }
      case 'gateway.execute': {
        args[args.length - 1] = function (...callbackArgs) {
          return executeCh.tracePromise(cb, {}, this, ...callbackArgs)
        }
        break
      }
      case 'gateway.fetch': {
        args[args.length - 1] = function (...callbackArgs) {
          return fetchCh.tracePromise(cb, { attributes: args[1].attributes }, this, ...callbackArgs)
        }
        break
      }
      case 'gateway.postprocessing' : {
        args[args.length - 1] = function (...callbackArgs) {
          return postProcessingCh.tracePromise(cb, {}, this, ...callbackArgs)
        }
        break
      }
      default:
        return startActiveSpan.apply(this, args)
    }
    return startActiveSpan.apply(this, args)
  }
}

addHook({ name: '@apollo/gateway', file: 'dist/utilities/opentelemetry.js', versions: ['>=2.3.0'] },
  (obj) => {
    const newTracerProto = Object.getPrototypeOf(obj.tracer)
    shimmer.wrap(newTracerProto, 'startActiveSpan', wrapStartActiveSpan)
    shimmer.wrap(obj, 'recordExceptions', wrapRecordExceptions)
    return obj
  })

addHook({ name: '@apollo/gateway', versions: ['>=2.3.0'] }, (gateway) => {
  shimmer.wrap(gateway, 'ApolloGateway', wrapApolloGateway)
  return gateway
})
