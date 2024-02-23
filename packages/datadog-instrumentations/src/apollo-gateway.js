const {
  addHook,
  channel
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')
const tracingChannel = require('dc-polyfill').tracingChannel

const validateCh = tracingChannel('apm:apollo-gateway:validate')
const requestCh = tracingChannel('apm:apollo-gateway:request')
const executeCh = tracingChannel('apm:apollo-gateway:execute')
const postProcessingCh = tracingChannel('apm:apollo-gateway:postprocessing')

const generalErrorCh = channel('apm:apollo-gateway:general:error')

const planStartCh = channel('apm:apollo-gateway:plan:start')
const planErrorCh = channel('apm:apollo-gateway:plan:error')
const planEndCh = channel('apm:apollo-gateway:plan:end')

const fetchStartCh = channel('apm:apollo-gateway:fetch:start')
const fetchEndCh = channel('apm:apollo-gateway:fetch:end')

function wrapExecuteQueryPlan (executeQueryPlan) {
  return function wrappedExecuteQueryPlan (...args) {
    return executeCh.tracePromise(executeQueryPlan, {}, this, ...args)
  }
}

function wrapComputeResponse (computeResponse) {
  return function wrappedComputeResponse (...args) {
    return postProcessingCh.traceSync(computeResponse, {}, this, ...args)
  }
}

function wrapFetchNode (FetchNode) {
  return function (...args) {
    try {
      return FetchNode.apply(this, arguments)
    } finally {
      fetchStartCh.publish({ properties: args[0] })
    }
  }
}

function wrapQueryPlanNode (QueryPlanNode) {
  return function (...args) {
    if (!args[0]?.fetch) return QueryPlanNode.apply(this, arguments)
    fetchEndCh.publish({})
    return QueryPlanNode.apply(this, arguments)
  }
}

function wrapExecutor (executor) {
  return function (...args) {
    const ctx = { requestContext: args[0], gateway: this }
    return requestCh.tracePromise(executor, ctx, this, ...args)
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

function wrapValidateIncomingRequest (validateIncomingRequest) {
  return function (...args) {
    const ctx = { requestContext: args[0] }
    return validateCh.traceSync(validateIncomingRequest, ctx, this, ...args)
  }
}

function wrapRecordExceptions (recordExceptions) {
  return function wrappedRecordExceptions (...args) {
    const errors = args[1]
    // only the last exception in the array of exceptions will be reported on the span,
    // this is mimicking apollo-gateways internal instrumentation
    // TODO: should we consider a mechanism to report all exceptions? since this method aggregates all exceptions
    // where as a span can only have one exception set on it at a time
    generalErrorCh.publish({ error: errors[errors.length - 1] })
    return recordExceptions.apply(this, arguments)
  }
}

function wrapBuildQueryPlan (buildQueryPlan) {
  return function (...args) {
    const ctx = {}
    try {
      return buildQueryPlan.apply(this, arguments)
    } catch (e) {
      ctx.error = e
      planErrorCh.publish(ctx)
    } finally {
      planEndCh.publish(ctx)
    }
  }
}

function wrapOperationFromDocument (operationFromDocument) {
  return function (...args) {
    if (!(args.length > 2 && 'operationName' in args[2])) { return operationFromDocument.apply(this, arguments) }
    const ctx = { operationName: args[2].operationName }
    try {
      planStartCh.publish(ctx)
      return operationFromDocument.apply(this, arguments)
    } catch (e) {
      ctx.error = e
      planErrorCh.publish(ctx)
    }
  }
}

addHook({ name: '@apollo/usage-reporting-protobuf', versions: ['>=4'] }, (obj) => {
  shimmer.wrap(obj.Trace.QueryPlanNode, 'FetchNode', FetchNode => wrapFetchNode(FetchNode))
  shimmer.wrap(obj.Trace, 'QueryPlanNode', QueryPlanNode => wrapQueryPlanNode(QueryPlanNode))
  return obj
})

addHook({ name: '@apollo/gateway', file: 'dist/executeQueryPlan.js', versions: ['>=2.3.0'] }, (executeQueryPlan) => {
  shimmer.wrap(executeQueryPlan, 'executeQueryPlan', wrapExecuteQueryPlan)
  return executeQueryPlan
})

addHook({ name: '@apollo/gateway', file: 'dist/resultShaping.js', versions: ['>=2.3.0'] }, (computeResponse) => {
  return shimmer.wrap(computeResponse, 'computeResponse', wrapComputeResponse)
})

addHook({
  name: '@apollo/federation-internals', file: 'dist/operations.js', versions: ['>=2.3.0']
}, (obj) => {
  shimmer.wrap(obj, 'operationFromDocument', wrapOperationFromDocument)
  return obj
})

addHook({ name: '@apollo/query-planner', versions: ['>=2.3.0'] }, (queryPlanner) => {
  shimmer.wrap(queryPlanner.QueryPlanner.prototype, 'buildQueryPlan', wrapBuildQueryPlan)
  return queryPlanner
})

addHook({ name: '@apollo/gateway', versions: ['>=2.3.0'] }, (gateway) => {
  shimmer.wrap(gateway, 'ApolloGateway', wrapApolloGateway)
  shimmer.wrap(gateway.ApolloGateway.prototype, 'validateIncomingRequest', wrapValidateIncomingRequest)
  return gateway
})

addHook({ name: '@apollo/gateway', file: 'dist/utilities/opentelemetry.js', versions: ['>=2.3.0'] }, (obj) => {
  shimmer.wrap(obj, 'recordExceptions', wrapRecordExceptions)
  return obj
})
