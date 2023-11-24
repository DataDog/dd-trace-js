'use strict'

const { storage } = require('../../../datadog-core')
const waf = require('./waf')
const addresses = require('./addresses')
const {
  graphqlFinishExecute,
  graphqlStartResolve
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

function enable () {
  graphqlFinishExecute.subscribe(onGraphqlFinishExecute)
  graphqlStartResolve.subscribe(onGraphqlStartResolve)
}

function disable () {
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
  const store = storage.getStore()
  const req = store?.req

  if (!req) return

  for (const [key, value] of Object.entries(args)) {
    if (value === 'attack') {
      abortController.abort()
    }
  }
}

module.exports = {
  enable,
  disable
}
