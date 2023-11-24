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
// @apollo/server
const startGraphqlMiddleware = channel('datadog:apollo:middleware:start')
const endGraphqlMiddleware = channel('datadog:apollo:middleware:end')
const startExecuteHTTPGraphQLRequest = channel('datadog:apollo:request:start')
const startGraphqlWrite = channel('datadog:apollo:response-write:start')

// apollo-server-core (used in apollo-server-fastify|express|...
const startRunHttpQuery = channel('datadog:apollo-core:runhttpquery:start')
const successRunHttpQuery = channel('datadog:apollo-core:runhttpquery:success')

const graphqlRequestData = new WeakMap()

function enable () {
  enableApollo()
}

function disable () {
  disableApollo()
}

// Starts @apollo/server related logic
function enterInApolloMiddleware ({ req }) {
  if (!req) return

  graphqlRequestData.set(req, {
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
  const store = storage.getStore()
  if (!store) return

  const { req, res } = store
  const requestData = graphqlRequestData.get(req)

  if (requestData?.blocked) {
    const rootSpan = web.root(req)
    if (!rootSpan) return
    block(req, res, rootSpan, abortController)
  }
}

// Starts apollo-server-core related logic
function enterInApolloCoreHttpQuery () {
  const req = storage.getStore()?.req
  if (!req) return

  graphqlRequestData.set(req, {
    isInGraphqlRequest: true,
    blocked: true
  })
}
function beforeWriteApolloCoreGraphqlResponse ({ abortController, abortData }) {
  const req = storage.getStore()?.req
  if (!req) return

  const requestData = graphqlRequestData.get(req)

  if (requestData?.blocked) {
    // TODO
    //  Change by real data, probably we should
    //  implement new block method, just to get the data
    abortData.code = 403
    abortData.headers = {
      'Content-Type': 'application/json'
    }
    abortData.message = JSON.stringify({
      'message': 'you are blocked'
    })
    abortController.abort()
  }
}

function enableApollo () {
  startGraphqlMiddleware.subscribe(enterInApolloMiddleware)
  startRunHttpQuery.subscribe(enterInApolloCoreHttpQuery)
  startExecuteHTTPGraphQLRequest.subscribe(enterInApolloRequest)
  endGraphqlMiddleware.subscribe(exitFromApolloMiddleware)
  startGraphqlWrite.subscribe(beforeWriteGraphqlResponse)
  successRunHttpQuery.subscribe(beforeWriteApolloCoreGraphqlResponse)
}

function disableApollo () {
  startGraphqlMiddleware.unsubscribe(enterInApolloMiddleware)
  startRunHttpQuery.unsubscribe(enterInApolloCoreHttpQuery)
  startExecuteHTTPGraphQLRequest.unsubscribe(enterInApolloRequest)
  endGraphqlMiddleware.unsubscribe(exitFromApolloMiddleware)
  startGraphqlWrite.unsubscribe(beforeWriteGraphqlResponse)
  successRunHttpQuery.unsubscribe(beforeWriteApolloCoreGraphqlResponse)
}
module.exports = {
  enable, disable
}
