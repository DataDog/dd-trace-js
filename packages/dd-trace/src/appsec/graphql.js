'use strict'

const { storage } = require('../../../datadog-core')
const {
  addSpecificEndpoint,
  specificBlockingTypes,
  getBlockingData,
  getBlockingAction
} = require('./blocking')
const log = require('../log')
const waf = require('./waf')
const addresses = require('./addresses')
const WebPlugin = require('../../../datadog-plugin-web/src')
const {
  startGraphqlResolve,
  graphqlMiddlewareChannel,
  apolloHttpServerChannel,
  apolloChannel,
  apolloServerCoreChannel
} = require('./channels')
const { updateBlockFailureMetric } = require('./telemetry')

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
  const req = storage('legacy').getStore()?.req

  if (!req) return

  if (!resolverInfo || typeof resolverInfo !== 'object') return

  const result = waf.run({ ephemeral: { [addresses.HTTP_INCOMING_GRAPHQL_RESOLVER]: resolverInfo } }, req)
  const blockingAction = getBlockingAction(result?.actions)
  if (blockingAction) {
    const requestData = graphqlRequestData.get(req)
    if (requestData?.isInGraphqlRequest) {
      requestData.blocked = true
      requestData.wafAction = blockingAction
      context?.abortController?.abort()
    }
  }
}

function enterInApolloMiddleware (data) {
  const req = data?.req || storage('legacy').getStore()?.req
  if (!req) return

  graphqlRequestData.set(req, {
    blocked: false
  })
}

function enterInApolloServerCoreRequest () {
  const req = storage('legacy').getStore()?.req
  if (!req) return

  graphqlRequestData.set(req, {
    isInGraphqlRequest: true,
    blocked: false
  })
}

function enterInApolloRequest () {
  const req = storage('legacy').getStore()?.req

  const requestData = graphqlRequestData.get(req)
  if (requestData) {
    // Set isInGraphqlRequest=true since this function only runs for GraphQL requests
    // This works for both Apollo v4 (middleware) and v5 (HTTP server) contexts
    requestData.isInGraphqlRequest = true
    addSpecificEndpoint(req.method, req.originalUrl || req.url, specificBlockingTypes.GRAPHQL)
  }
}

function beforeWriteApolloGraphqlResponse ({ abortController, abortData }) {
  const req = storage('legacy').getStore()?.req
  if (!req) return

  const requestData = graphqlRequestData.get(req)

  if (requestData?.blocked) {
    const rootSpan = WebPlugin.root(req)
    if (!rootSpan) return

    try {
      const blockingData = getBlockingData(req, specificBlockingTypes.GRAPHQL, requestData.wafAction)
      abortData.statusCode = blockingData.statusCode
      abortData.headers = blockingData.headers
      abortData.message = blockingData.body

      rootSpan.setTag('appsec.blocked', 'true')

      abortController?.abort()
    } catch (err) {
      rootSpan.setTag('_dd.appsec.block.failed', 1)
      log.error('[ASM] Blocking error', err)

      updateBlockFailureMetric(req)
    }
  }

  graphqlRequestData.delete(req)
}

function enableApollo () {
  graphqlMiddlewareChannel.subscribe({
    start: enterInApolloMiddleware
  })

  apolloServerCoreChannel.subscribe({
    start: enterInApolloServerCoreRequest,
    asyncEnd: beforeWriteApolloGraphqlResponse
  })

  apolloChannel.subscribe({
    start: enterInApolloRequest,
    asyncEnd: beforeWriteApolloGraphqlResponse
  })

  apolloHttpServerChannel.subscribe({
    start: enterInApolloMiddleware
  })
}

function disableApollo () {
  graphqlMiddlewareChannel.unsubscribe({
    start: enterInApolloMiddleware
  })

  apolloServerCoreChannel.unsubscribe({
    start: enterInApolloServerCoreRequest,
    asyncEnd: beforeWriteApolloGraphqlResponse
  })

  apolloChannel.unsubscribe({
    start: enterInApolloRequest,
    asyncEnd: beforeWriteApolloGraphqlResponse
  })

  apolloHttpServerChannel.unsubscribe({
    start: enterInApolloMiddleware
  })
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
