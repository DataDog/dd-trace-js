'use strict'

const { storage } = require('../../../datadog-core')
const { addSpecificEndpoint, specificBlockingTypes, getBlockingData } = require('./blocking')
const waf = require('./waf')
const addresses = require('./addresses')
const web = require('../plugins/util/web')
const {
  startGraphqlResolve,
  startGraphqlMiddleware,
  endGraphqlMiddleware,
  startExecuteHTTPGraphQLRequest,
  startGraphqlWrite,
  startApolloServerCoreRequest,
  successApolloServerCoreRequest
} = require('./channels')

const graphqlRequestData = new WeakMap()

function enable () {
  enableApollo()
  enableGraphql()
}

function disable () {
  disableApollo()
  disableGraphql()
}

function onGraphqlStartResolve ({ context, resolverInfo }) {
  const req = storage.getStore()?.req

  if (!req) return

  if (!resolverInfo || typeof resolverInfo !== 'object') return

  const actions = waf.run({ [addresses.HTTP_INCOMING_GRAPHQL_RESOLVER]: resolverInfo }, req)
  if (actions?.includes('block')) {
    const requestData = graphqlRequestData.get(req)
    if (requestData?.isInGraphqlRequest) {
      requestData.blocked = true
      context?.abortController?.abort()
    }
  }
}

// Starts @apollo/server and apollo-server-core related logic
function enterInApolloMiddleware (data) {
  const req = data?.req || storage.getStore()?.req
  if (!req) return

  graphqlRequestData.set(req, {
    inApolloMiddleware: true,
    blocked: false
  })
}

function enterInApolloServerCoreRequest () {
  const req = storage.getStore()?.req
  if (!req) return

  graphqlRequestData.set(req, {
    isInGraphqlRequest: true,
    blocked: false
  })
}

function exitFromApolloMiddleware (data) {
  const req = data?.req || storage.getStore()?.req
  const requestData = graphqlRequestData.get(req)
  if (requestData) requestData.inApolloMiddleware = false
}

function enterInApolloRequest () {
  const req = storage.getStore()?.req

  const requestData = graphqlRequestData.get(req)
  if (requestData?.inApolloMiddleware) {
    requestData.isInGraphqlRequest = true
    addSpecificEndpoint(req.method, req.originalUrl || req.url, specificBlockingTypes.GRAPHQL)
  }
}

function beforeWriteApolloGraphqlResponse ({ abortController, abortData }) {
  const req = storage.getStore()?.req
  if (!req) return

  const requestData = graphqlRequestData.get(req)

  if (requestData?.blocked) {
    const rootSpan = web.root(req)
    if (!rootSpan) return

    const blockingData = getBlockingData(req, specificBlockingTypes.GRAPHQL, rootSpan)
    abortData.statusCode = blockingData.statusCode
    abortData.headers = blockingData.headers
    abortData.message = blockingData.body

    abortController.abort()
  }
}

function enableApollo () {
  startGraphqlMiddleware.subscribe(enterInApolloMiddleware)
  startExecuteHTTPGraphQLRequest.subscribe(enterInApolloRequest)
  startApolloServerCoreRequest.subscribe(enterInApolloServerCoreRequest)
  endGraphqlMiddleware.subscribe(exitFromApolloMiddleware)
  startGraphqlWrite.subscribe(beforeWriteApolloGraphqlResponse)
  successApolloServerCoreRequest.subscribe(beforeWriteApolloGraphqlResponse)
}

function disableApollo () {
  if (startGraphqlMiddleware.hasSubscribers) startGraphqlMiddleware.unsubscribe(enterInApolloMiddleware)
  if (startExecuteHTTPGraphQLRequest.hasSubscribers) startExecuteHTTPGraphQLRequest.unsubscribe(enterInApolloRequest)
  if (startApolloServerCoreRequest.hasSubscribers) {
    startApolloServerCoreRequest.unsubscribe(enterInApolloServerCoreRequest)
  }
  if (endGraphqlMiddleware.hasSubscribers) endGraphqlMiddleware.unsubscribe(exitFromApolloMiddleware)
  if (startGraphqlWrite.hasSubscribers) startGraphqlWrite.unsubscribe(beforeWriteApolloGraphqlResponse)
  if (successApolloServerCoreRequest.hasSubscribers) startGraphqlWrite.unsubscribe(beforeWriteApolloGraphqlResponse)
}

function enableGraphql () {
  startGraphqlResolve.subscribe(onGraphqlStartResolve)
}

function disableGraphql () {
  if (startGraphqlResolve.hasSubscribers) startGraphqlResolve.unsubscribe(onGraphqlStartResolve)
}

module.exports = {
  enable,
  disable
}
