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
  wafRunFinished,
  apolloHttpServerChannel,
  apolloChannel,
  apolloServerCoreChannel,
} = require('./channels')
const { updateBlockFailureMetric } = require('./telemetry')

const graphqlRequestData = new WeakMap()

/**
 * Per request, the blocking action of every field already checked without arguments, `undefined` when the WAF
 * requested none. A `{ fieldName: {} }` payload exposes nothing but the field name, so the WAF returns the same
 * action for every occurrence of that field, as long as the request's WAF context keeps the same persistent
 * inputs. List queries resolve the same fields once per item.
 *
 * @type {WeakMap<object, Map<string, object | undefined>>}
 */
const fieldsWithoutArgumentsActions = new WeakMap()

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

  const fieldName = getFieldNameWithoutArguments(resolverInfo)
  const knownActions = fieldName === undefined ? undefined : fieldsWithoutArgumentsActions.get(req)
  if (knownActions?.has(fieldName)) {
    applyBlockingAction(req, data, knownActions.get(fieldName))
    return
  }

  const result = waf.run({ ephemeral: { [addresses.HTTP_INCOMING_GRAPHQL_RESOLVER]: resolverInfo } }, req)
  const blockingAction = getBlockingAction(result?.actions)

  // A run that timed out, failed, or found no rule to evaluate is not an answer about the field, so let the next
  // occurrence run again instead of reading it back as "allowed".
  if (fieldName !== undefined && result !== undefined && !result.timeout) {
    if (knownActions === undefined) {
      fieldsWithoutArgumentsActions.set(req, new Map([[fieldName, blockingAction]]))
    } else {
      knownActions.set(fieldName, blockingAction)
    }
  }

  applyBlockingAction(req, data, blockingAction)
}

/**
 * Persistent inputs stay in the request's WAF context, so they can change the action of a field checked before
 * they arrived. Forget what we know about the request when a run carries them. Resolver runs send ephemeral
 * inputs only, so they never invalidate their own answers.
 *
 * @param {{ payload?: { persistent?: object } }} data
 */
function onWafRunFinished ({ payload }) {
  if (!payload?.persistent) return

  const req = getActiveRequest()
  if (!req) return

  fieldsWithoutArgumentsActions.delete(req)
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
  wafRunFinished.subscribe(onWafRunFinished)
}

function disableGraphql () {
  if (startGraphqlResolver.hasSubscribers) startGraphqlResolver.unsubscribe(onGraphqlStartResolver)
  if (wafRunFinished.hasSubscribers) wafRunFinished.unsubscribe(onWafRunFinished)
}

module.exports = {
  enable,
  disable,
}
