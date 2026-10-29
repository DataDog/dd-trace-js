'use strict'

const log = require('../log')
const web = require('../plugins/util/web')
const { isEmpty } = require('../util')
const { getActiveRequest } = require('./store')
const {
  addSpecificEndpoint,
  specificBlockingTypes,
  getBlockingData,
  getBlockingAction,
} = require('./blocking')
const waf = require('./waf')
const addresses = require('./addresses')
const {
  startGraphqlResolver,
  graphqlMiddlewareChannel,
  apolloHttpServerChannel,
  apolloChannel,
  apolloServerCoreChannel,
} = require('./channels')
const { updateBlockFailureMetric } = require('./telemetry')

const graphqlRequestData = new WeakMap()

/**
 * Per request, the blocking action (or `undefined`) of every field already checked without arguments.
 *
 * @type {WeakMap<object, Map<string, object | undefined>>}
 */
const fieldsWithoutArgumentsResults = new WeakMap()

function enable () {
  enableApollo()
  enableGraphql()
}

function disable () {
  disableApollo()
  disableGraphql()
}

/**
 * @param {{ createResolverInfo?: (data: object) => object | null }} data
 */
function onGraphqlStartResolver (data) {
  const req = getActiveRequest()

  if (!req) return

  const resolverInfo = data.createResolverInfo?.(data)
  if (!resolverInfo || typeof resolverInfo !== 'object') return

  // `{ fieldName: {} }` only exposes the field name, so the WAF result is the same for every occurrence of that
  // field in the request. List queries resolve the same fields once per item.
  const fieldName = getFieldNameWithoutArguments(resolverInfo)
  let fieldResults
  if (fieldName !== undefined) {
    fieldResults = fieldsWithoutArgumentsResults.get(req)
    if (fieldResults?.has(fieldName)) {
      applyBlockingAction(req, data, fieldResults.get(fieldName))
      return
    }
  }

  const result = waf.run({ ephemeral: { [addresses.HTTP_INCOMING_GRAPHQL_RESOLVER]: resolverInfo } }, req)
  const blockingAction = getBlockingAction(result?.actions)

  if (fieldName !== undefined) {
    if (!fieldResults) {
      fieldResults = new Map()
      fieldsWithoutArgumentsResults.set(req, fieldResults)
    }
    fieldResults.set(fieldName, blockingAction)
  }

  applyBlockingAction(req, data, blockingAction)
}

/**
 * @param {object} resolverInfo
 * @returns {string | undefined} the field name when the payload is `{ fieldName: {} }`
 */
function getFieldNameWithoutArguments (resolverInfo) {
  let fieldName
  for (const key in resolverInfo) {
    if (fieldName !== undefined) return
    fieldName = key
  }
  if (fieldName === undefined) return

  const fieldArguments = resolverInfo[fieldName]
  if (!fieldArguments || typeof fieldArguments !== 'object' || !isEmpty(fieldArguments)) return

  return fieldName
}

/**
 * @param {object} req
 * @param {{ abortController?: AbortController }} data
 * @param {object | undefined} blockingAction
 */
function applyBlockingAction (req, data, blockingAction) {
  if (!blockingAction) return

  const requestData = graphqlRequestData.get(req)
  if (requestData?.isInGraphqlRequest) {
    requestData.blocked = true
    requestData.wafAction = blockingAction
    data.abortController?.abort()
  }
}

function enterInApolloMiddleware (data) {
  const req = data?.req || getActiveRequest()
  if (!req) return

  graphqlRequestData.set(req, {
    blocked: false,
  })
}

function enterInApolloServerCoreRequest () {
  const req = getActiveRequest()
  if (!req) return

  graphqlRequestData.set(req, {
    isInGraphqlRequest: true,
    blocked: false,
  })
}

function enterInApolloRequest () {
  const req = getActiveRequest()
  if (!req) return

  let requestData = graphqlRequestData.get(req)
  if (!requestData) {
    // executeHTTPGraphQLRequest is the GraphQL request boundary, so seed here
    // when no upstream hook (express4 middleware, drainHttpServer) has run.
    requestData = { blocked: false }
    graphqlRequestData.set(req, requestData)
  }
  requestData.isInGraphqlRequest = true
  addSpecificEndpoint(req, specificBlockingTypes.GRAPHQL)
}

function beforeWriteApolloGraphqlResponse ({ abortController, abortData }) {
  const req = getActiveRequest()
  if (!req) return

  const requestData = graphqlRequestData.get(req)

  if (requestData?.blocked) {
    const rootSpan = web.root(req)
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
    start: enterInApolloMiddleware,
  })

  apolloServerCoreChannel.subscribe({
    start: enterInApolloServerCoreRequest,
    asyncEnd: beforeWriteApolloGraphqlResponse,
  })

  apolloChannel.subscribe({
    start: enterInApolloRequest,
    asyncEnd: beforeWriteApolloGraphqlResponse,
  })

  apolloHttpServerChannel.subscribe({
    start: enterInApolloMiddleware,
  })
}

function disableApollo () {
  graphqlMiddlewareChannel.unsubscribe({
    start: enterInApolloMiddleware,
  })

  apolloServerCoreChannel.unsubscribe({
    start: enterInApolloServerCoreRequest,
    asyncEnd: beforeWriteApolloGraphqlResponse,
  })

  apolloChannel.unsubscribe({
    start: enterInApolloRequest,
    asyncEnd: beforeWriteApolloGraphqlResponse,
  })

  apolloHttpServerChannel.unsubscribe({
    start: enterInApolloMiddleware,
  })
}

function enableGraphql () {
  startGraphqlResolver.subscribe(onGraphqlStartResolver)
}

function disableGraphql () {
  if (startGraphqlResolver.hasSubscribers) startGraphqlResolver.unsubscribe(onGraphqlStartResolver)
}

module.exports = {
  enable,
  disable,
}
