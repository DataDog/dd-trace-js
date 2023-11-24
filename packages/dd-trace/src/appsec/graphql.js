'use strict'

const { storage } = require('../../../datadog-core')
const { block } = require('./blocking')
const web = require('../plugins/util/web')
const waf = require('./waf')
const addresses = require('./addresses')
const {
  graphqlFinishExecute,
  graphqlStartResolve,
  startGraphqlMiddleware,
  endGraphqlMiddleware,
  startExecuteHTTPGraphQLRequest,
  startGraphqlWrite
} = require('./channels')

/** TODO
 *    - Instrumentate @apollo/server to:
 *      - Mark a request as graphql endpoint
 *      - Detect graphql endpoints and use it to block even when the request is blocked on http level
 *      - When the graphql detects an rule to block, replace the response with the graphql blocking response
 *    - Instrumentate graphql to:
 *      - monitor threats (done)
 *      - mark the request as blocked somehow
 */

const graphqlRequestData = new WeakMap()

function enable () {
  enableApollo()
  graphqlFinishExecute.subscribe(onGraphqlFinishExecute)
  graphqlStartResolve.subscribe(onGraphqlStartResolve)
}

function disable () {
  disableApollo()
  if (graphqlFinishExecute.hasSubscribers) graphqlFinishExecute.unsubscribe(onGraphqlFinishExecute)
  if (graphqlStartResolve.hasSubscribers) graphqlStartResolve.unsubscribe(onGraphqlStartResolve)
}

function onGraphqlFinishExecute ({ context }) {
  const store = storage.getStore()
  const req = store?.req

  if (!req) return

  const resolvers = context?.resolvers

  if (!resolvers || typeof resolvers !== 'object') return

  // Don't collect blocking result because it only works in monitor mode.
  waf.run({ [addresses.HTTP_INCOMING_GRAPHQL_RESOLVERS]: resolvers }, req)
}

function onGraphqlStartResolve ({ info, context, args, abortController }) {
  const req = storage.getStore()?.req

  if (!req) return

  for (const [key, value] of Object.entries(args)) {
    if (value === 'attack') {
      const requestData = graphqlRequestData.get(req)
      if (requestData.isInGraphqlRequest) {
        requestData.blocked = true
        abortController.abort()
      }
    }
  }
}

// Starts @apollo/server related logic
function enterInApolloMiddleware ({ req, res }) {
  graphqlRequestData.set(req, {
    res,
    inApolloMiddleware: true,
    blocked: false
  })
}

function exitFromApolloMiddleware ({ req }) {
  const requestData = graphqlRequestData.get(req)
  if (requestData) requestData.inApolloMiddleware = false
}

function enterInApolloRequest () {
  const req = storage.getStore()?.req
  const requestData = graphqlRequestData.get(req)
  if (requestData?.inApolloMiddleware) {
    requestData.isInGraphqlRequest = true
  }
}

function beforeWriteGraphqlResponse ({ abortController }) {
  const req = storage.getStore()?.req
  const requestData = graphqlRequestData.get(req)
  if (requestData?.blocked) {
    const rootSpan = web.root(req)
    if (!rootSpan) return
    block(req, requestData.res, rootSpan, abortController)
  }
}

function enableApollo () {
  startGraphqlMiddleware.subscribe(enterInApolloMiddleware)
  startExecuteHTTPGraphQLRequest.subscribe(enterInApolloRequest)
  endGraphqlMiddleware.subscribe(exitFromApolloMiddleware)
  startGraphqlWrite.subscribe(beforeWriteGraphqlResponse)
}

function disableApollo () {
  startGraphqlMiddleware.unsubscribe(enterInApolloMiddleware)
  startExecuteHTTPGraphQLRequest.unsubscribe(enterInApolloRequest)
  endGraphqlMiddleware.unsubscribe(exitFromApolloMiddleware)
  startGraphqlWrite.subscribe(beforeWriteGraphqlResponse)
}

module.exports = {
  enable,
  disable
}
