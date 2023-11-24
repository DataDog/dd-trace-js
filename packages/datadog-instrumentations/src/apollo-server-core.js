'use strict'

const { addHook, channel, AsyncResource } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')
const { AbortController } = require('node-abort-controller')

const startRunHttpQuery = channel('datadog:apollo-core:runhttpquery:start')
const successRunHttpQuery = channel('datadog:apollo-core:runhttpquery:success')

addHook({ name: 'apollo-server-core', file: 'dist/runHttpQuery.js', versions: ['>3.0.0'] }, runHttpQueryModule => {
  const HttpQueryError = runHttpQueryModule.HttpQueryError
  shimmer.wrap(runHttpQueryModule, 'runHttpQuery', function wrapRunHttpQuery (originalRunHttpQuery) {
    return async function runHttpQuery () {
      if (!startRunHttpQuery.hasSubscribers) {
        return originalRunHttpQuery.apply(this, arguments)
      }

      const asyncResource = new AsyncResource('bound-anonymous-fn')
      return asyncResource.runInAsyncScope(async () => {
        startRunHttpQuery.publish()

        const abortController = new AbortController()
        const abortData = {}

        const httpRunPromise = await originalRunHttpQuery.apply(this, arguments)

        return asyncResource.runInAsyncScope(() => {
          successRunHttpQuery.publish({ abortController, abortData })
          if (abortController.signal.aborted) {
            return new Promise((resolve, reject) => {
              const error = new HttpQueryError(abortData.statusCode, abortData.message, false, abortData.headers)

              reject(error)
            })
          }

          return httpRunPromise
        })
      })
    }
  })

  return runHttpQueryModule
})
