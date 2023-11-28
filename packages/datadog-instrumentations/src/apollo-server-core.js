'use strict'

const { addHook, channel, AsyncResource } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')
const { AbortController } = require('node-abort-controller')

const startGraphqlMiddleware = channel('datadog:apollo:middleware:start')
const endGraphqlMiddleware = channel('datadog:apollo:middleware:end')

const startGraphQLRequest = channel('datadog:apollo:request:start')
const successGraphqlRequest = channel('datadog:apollo:request:success')

addHook({ name: 'apollo-server-core', file: 'dist/runHttpQuery.js', versions: ['>3.0.0'] }, runHttpQueryModule => {
  const HttpQueryError = runHttpQueryModule.HttpQueryError
  shimmer.wrap(runHttpQueryModule, 'runHttpQuery', function wrapRunHttpQuery (originalRunHttpQuery) {
    return async function runHttpQuery () {
      if (!startGraphQLRequest.hasSubscribers) {
        return originalRunHttpQuery.apply(this, arguments)
      }

      const asyncResource = new AsyncResource('bound-anonymous-fn')
      return asyncResource.runInAsyncScope(async () => {
        startGraphqlMiddleware.publish()
        startGraphQLRequest.publish()

        const abortController = new AbortController()
        const abortData = {}

        const httpRunPromise = originalRunHttpQuery.apply(this, arguments)
        endGraphqlMiddleware.publish()

        const result = await httpRunPromise
        return asyncResource.runInAsyncScope(() => {
          successGraphqlRequest.publish({ abortController, abortData })
          if (abortController.signal.aborted) {
            return new Promise((resolve, reject) => {
              // runHttpQuery callbacks are writing the response on resolve/reject.
              // We should return blocking data in the apollo-server-core HttpQueryError object
              const error = new HttpQueryError(abortData.statusCode, abortData.message, true, abortData.headers)

              reject(error)
            })
          }

          return result
        })
      })
    }
  })

  return runHttpQueryModule
})
