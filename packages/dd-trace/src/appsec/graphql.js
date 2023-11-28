'use strict'

const { storage } = require('../../../datadog-core')
const { addCustomEndpoint, customBlockingTypes, getBlockingData } = require('./blocking')
const waf = require('./waf')
const addresses = require('./addresses')
const web = require('../plugins/util/web')
const {
  graphqlStartResolve,
  startGraphqlMiddleware,
  endGraphqlMiddleware,
  startExecuteHTTPGraphQLRequest,
  startGraphqlWrite
} = require('./channels')

/** TODO
 *    - Instrumentate @apollo/server to:
 *      - Mark a request as graphql endpoint (done)
 *      - Detect graphql endpoints and use it to block even when the request is blocked on http level (done)
 *      - When the graphql detects an rule to block, replace the response with the graphql blocking response (done)
 *    - Instrumentate graphql to:
 *      - monitor threats (done)
 *      - mark the request as blocked somehow
 */

const graphqlRequestData = new WeakMap()

function enable () {
  enableApollo()
  graphqlStartResolve.subscribe(onGraphqlStartResolve)
}

function disable () {
  disableApollo()
  if (graphqlStartResolve.hasSubscribers) graphqlStartResolve.unsubscribe(onGraphqlStartResolve)
}

function onGraphqlStartResolve ({ info, context }) {
  const req = storage.getStore()?.req

  if (!req) return

  const resolvers = context?.resolvers

  if (!resolvers || typeof resolvers !== 'object') return

  const actions = waf.run({ [addresses.HTTP_INCOMING_GRAPHQL_RESOLVER]: resolvers }, req)
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
    addCustomEndpoint(req.method, req.originalUrl || req.url, customBlockingTypes.GRAPHQL)
  }
}

function beforeWriteApolloCoreGraphqlResponse ({ abortController, abortData }) {
  const req = storage.getStore()?.req
  if (!req) return

  const requestData = graphqlRequestData.get(req)

  if (requestData?.blocked) {
    const rootSpan = web.root(req)
    if (!rootSpan) return

    const blockingData = getBlockingData(req, customBlockingTypes.GRAPHQL, rootSpan)
    abortData.statusCode = blockingData.statusCode
    abortData.headers = blockingData.headers
    abortData.message = blockingData.body

    abortController.abort()
  }
}

function enableApollo () {
  startGraphqlMiddleware.subscribe(enterInApolloMiddleware)
  startExecuteHTTPGraphQLRequest.subscribe(enterInApolloRequest)
  endGraphqlMiddleware.subscribe(exitFromApolloMiddleware)
  startGraphqlWrite.subscribe(beforeWriteApolloCoreGraphqlResponse)
}

function disableApollo () {
  if (startGraphqlMiddleware.hasSubscribers) startGraphqlMiddleware.unsubscribe(enterInApolloMiddleware)
  if (startExecuteHTTPGraphQLRequest.hasSubscribers) startExecuteHTTPGraphQLRequest.unsubscribe(enterInApolloRequest)
  if (endGraphqlMiddleware.hasSubscribers) endGraphqlMiddleware.unsubscribe(exitFromApolloMiddleware)
  if (startGraphqlWrite.hasSubscribers) startGraphqlWrite.unsubscribe(beforeWriteApolloCoreGraphqlResponse)
}

module.exports = {
  enable,
  disable
}
