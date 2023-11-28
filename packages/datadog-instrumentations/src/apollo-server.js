'use strict'

const { addHook, channel } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')
const { AbortController } = require('node-abort-controller')

const startGraphqlMiddleware = channel('datadog:apollo:middleware:start')
const endGraphqlMiddleware = channel('datadog:apollo:middleware:end')

const startGraphQLRequest = channel('datadog:apollo:request:start')
const successGraphqlRequest = channel('datadog:apollo:request:success')

function wrapExecuteHTTPGraphQLRequest (originalExecuteHTTPGraphQLRequest) {
  return async function executeHTTPGraphQLRequest (httpGraphQLRequest) {
    if (!startGraphQLRequest.hasSubscribers) return originalExecuteHTTPGraphQLRequest.apply(this, arguments)

    startGraphQLRequest.publish()

    const graphqlResponseData = await originalExecuteHTTPGraphQLRequest.apply(this, arguments)

    const abortController = new AbortController()
    const abortData = {}
    successGraphqlRequest.publish({ abortController, abortData })

    if (abortController.signal.aborted) {
      const headers = []
      Object.keys(abortData.headers).forEach(key => {
        headers.push([key, abortData.headers[key]])
      })
      return {
        headers: headers,
        status: abortData.statusCode,
        body: {
          kind: 'complete',
          string: abortData.message
        }
      }
    }

    return graphqlResponseData
  }
}

function apolloExpress4Hook (express4) {
  shimmer.wrap(express4, 'expressMiddleware', function wrapExpressMiddleware (originalExpressMiddleware) {
    return function expressMiddleware (server, options) {
      const originalMiddleware = originalExpressMiddleware.apply(this, arguments)

      return shimmer.wrap(originalMiddleware, function (req, res, next) {
        if (!startGraphqlMiddleware.hasSubscribers) {
          return originalMiddleware.apply(this, arguments)
        }

        startGraphqlMiddleware.publish({ req })
        const middlewareResult = originalMiddleware.apply(this, arguments)
        endGraphqlMiddleware.publish({ req })
        return middlewareResult
      })
    }
  })
  return express4
}

function apolloServerHook (apolloServer) {
  shimmer.wrap(apolloServer.ApolloServer.prototype, 'executeHTTPGraphQLRequest', wrapExecuteHTTPGraphQLRequest)
  return apolloServer
}
addHook({ name: '@apollo/server', file: 'dist/cjs/ApolloServer.js', versions: ['>=4.0.0'] }, apolloServerHook)
addHook({ name: '@apollo/server', file: 'dist/esm/ApolloServer.js', versions: ['>=4.0.0'] }, apolloServerHook)

addHook({ name: '@apollo/server', file: 'dist/cjs/express4/index.js', versions: ['>=4.0.0'] }, apolloExpress4Hook)
addHook({ name: '@apollo/server', file: 'dist/esm/express4/index.js', versions: ['>=4.0.0'] }, apolloExpress4Hook)
