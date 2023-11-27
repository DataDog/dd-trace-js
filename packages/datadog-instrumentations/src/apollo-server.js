'use strict'

const { addHook, channel } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')
const { AbortController } = require('node-abort-controller')

const startGraphqlMiddleware = channel('datadog:apollo:middleware:start')
const startExecuteHTTPGraphQLRequest = channel('datadog:apollo:request:start')
const endGraphqlMiddleware = channel('datadog:apollo:middleware:end')
const startGraphqlWrite = channel('datadog:apollo:response-write:start')

function wrapExecuteHTTPGraphQLRequest (originalExecuteHTTPGraphQLRequest) {
  return function executeHTTPGraphQLRequest (httpGraphQLRequest) {
    const requestPromise = originalExecuteHTTPGraphQLRequest.apply(this, arguments)

    if (!startExecuteHTTPGraphQLRequest.hasSubscribers) return requestPromise

    startExecuteHTTPGraphQLRequest.publish()

    shimmer.wrap(requestPromise, 'then', function wrapThen (originalThen) {
      return function then (callback) {
        if (typeof callback !== 'function') return originalThen.apply(this, arguments)

        arguments[0] = shimmer.wrap(callback, function () {
          const abortController = new AbortController()
          startGraphqlWrite.publish({ abortController })

          if (abortController.signal.aborted) return

          return callback.apply(this, arguments)
        })

        return originalThen.apply(this, arguments)
      }
    })

    return requestPromise
  }
}

addHook({ name: '@apollo/server', file: 'dist/cjs/ApolloServer.js', versions: ['>=4.0.0'] }, apolloServer => {
  shimmer.wrap(apolloServer.ApolloServer.prototype, 'executeHTTPGraphQLRequest', wrapExecuteHTTPGraphQLRequest)
  return apolloServer
})

addHook({ name: '@apollo/server', file: 'dist/cjs/express4/index.js', versions: ['>=4.0.0'] }, express4 => {
  shimmer.wrap(express4, 'expressMiddleware', function wrapExpressMiddleware (originalExpressMiddleware) {
    return function expressMiddleware (server, options) {
      const originalMiddleware = originalExpressMiddleware.apply(this, arguments)

      return shimmer.wrap(originalMiddleware, function (req, res, next) {
        if (!startGraphqlMiddleware.hasSubscribers) {
          return originalMiddleware.apply(this, arguments)
        }

        startGraphqlMiddleware.publish({ req, res })
        const middlewareResult = originalMiddleware.apply(this, arguments)
        endGraphqlMiddleware.publish({ req })
        return middlewareResult
      })
    }
  })
  return express4
})
