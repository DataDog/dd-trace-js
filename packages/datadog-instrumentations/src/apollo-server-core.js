'use strict'

const { AbortController } = require('node-abort-controller')
const { addHook, channel, AsyncResource } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const startApolloServerCoreRequest = channel('datadog:apollo-server-core:request:start')
const successApolloServerCoreRequest = channel('datadog:apollo-server-core:request:success')

addHook({ name: 'apollo-server-core', file: 'dist/runHttpQuery.js', versions: ['>3.0.0'] }, runHttpQueryModule => {
  const HttpQueryError = runHttpQueryModule.HttpQueryError

  shimmer.wrap(runHttpQueryModule, 'runHttpQuery', function wrapRunHttpQuery (originalRunHttpQuery) {
    return async function runHttpQuery () {
      if (!startApolloServerCoreRequest.hasSubscribers) {
        return originalRunHttpQuery.apply(this, arguments)
      }

      const asyncResource = new AsyncResource('bound-anonymous-fn')
      return asyncResource.runInAsyncScope(async () => {
        startApolloServerCoreRequest.publish()

        const runHttpQueryResult = await originalRunHttpQuery.apply(this, arguments)

        return asyncResource.runInAsyncScope(() => {
          const abortController = new AbortController()
          const abortData = {}
          successApolloServerCoreRequest.publish({ abortController, abortData })

          if (abortController.signal.aborted) {
            return new Promise((resolve, reject) => {
              // runHttpQuery callbacks are writing the response on resolve/reject.
              // We should return blocking data in the apollo-server-core HttpQueryError object
              const error = new HttpQueryError(abortData.statusCode, abortData.message, true, abortData.headers)

              reject(error)
            })
          }

          return runHttpQueryResult
        })
      })
    }
  })

  return runHttpQueryModule
})
