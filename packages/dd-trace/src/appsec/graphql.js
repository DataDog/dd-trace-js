'use strict'

const { channel } = require('../../../datadog-instrumentations/src/helpers/instrument')
const { storage } = require('../../../datadog-core')
const { block } = require('./blocking')
const web = require('../plugins/util/web')
/** TODO
 *    - Instrumentate @apollo/server to:
 *      - Mark a request as graphql endpoint
 *      - Detect graphql endpoints and use it to block even when the request is blocked on http level
 *      - When the graphql detects an rule to block, replace the response with the graphql blocking response
 *    - Instrumentate graphql to:
 *      - monitor threats (done)
 *      - mark the request as blocked somehow
 */
const startGraphqlMiddleware = channel('datadog:apollo:middleware:start')
const endGraphqlMiddleware = channel('datadog:apollo:middleware:end')
const startExecuteHTTPGraphQLRequest = channel('datadog:apollo:request:start')
const startGraphqlWrite = channel('datadog:apollo:response-write:start')

const graphqlRequestData = new WeakMap()

function enable () {
  enableApollo()
}

function disable () {
  disableApollo()
}

// Starts @apollo/server related logic
function enterInApolloMiddleware ({ req, res }) {
  graphqlRequestData.set(req, {
    res,
    inApolloMiddleware: true
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
  enable, disable
}
