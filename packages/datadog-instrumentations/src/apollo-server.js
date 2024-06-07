'use strict'

const dc = require('dc-polyfill')

const { addHook } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const graphqlMiddlewareChannel = dc.tracingChannel('datadog:apollo:middleware')

const requestChannel = dc.tracingChannel('datadog:apollo:request')

let HeaderMap

function wrapExecuteHTTPGraphQLRequest (originalExecuteHTTPGraphQLRequest) {
  return async function executeHTTPGraphQLRequest () {
    if (!HeaderMap || !requestChannel.start.hasSubscribers) {
      return originalExecuteHTTPGraphQLRequest.apply(this, arguments)
    }

    const abortController = new AbortController()
    const abortData = {}

    const graphqlResponseData = requestChannel.tracePromise(
      originalExecuteHTTPGraphQLRequest,
      { abortController, abortData },
      this,
      ...arguments)

    const abortPromise = new Promise((resolve, reject) => {
      abortController.signal.addEventListener('abort', (event) => {
        // This method is expected to return response data
        // with headers, status and body
        const headers = new HeaderMap()
        Object.keys(abortData.headers).forEach(key => {
          headers.set(key, abortData.headers[key])
        })

        resolve({
          headers,
          status: abortData.statusCode,
          body: {
            kind: 'complete',
            string: abortData.message
          }
        })
      }, { once: true })
    })

    return Promise.race([abortPromise, graphqlResponseData])
  }
}

function apolloExpress4Hook (express4) {
  shimmer.wrap(express4, 'expressMiddleware', function wrapExpressMiddleware (originalExpressMiddleware) {
    return function expressMiddleware (server, options) {
      const originalMiddleware = originalExpressMiddleware.apply(this, arguments)

      return shimmer.wrap(originalMiddleware, function (req, res, next) {
        if (!graphqlMiddlewareChannel.start.hasSubscribers) {
          return originalMiddleware.apply(this, arguments)
        }

        return graphqlMiddlewareChannel.traceSync(originalMiddleware, { req }, this, ...arguments)
      })
    }
  })
  return express4
}

function apolloHeaderMapHook (headerMap) {
  HeaderMap = headerMap.HeaderMap
  return headerMap
}

function apolloServerHook (apolloServer) {
  shimmer.wrap(apolloServer.ApolloServer.prototype, 'executeHTTPGraphQLRequest', wrapExecuteHTTPGraphQLRequest)
  return apolloServer
}

addHook({ name: '@apollo/server', file: 'dist/cjs/ApolloServer.js', versions: ['>=4.0.0'] }, apolloServerHook)
addHook({ name: '@apollo/server', file: 'dist/cjs/express4/index.js', versions: ['>=4.0.0'] }, apolloExpress4Hook)
addHook({ name: '@apollo/server', file: 'dist/cjs/utils/HeaderMap.js', versions: ['>=4.0.0'] }, apolloHeaderMapHook)
