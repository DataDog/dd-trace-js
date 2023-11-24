'use strict'

const { addHook, channel, AsyncResource } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')
const { AbortController } = require('node-abort-controller')

const startRunHttpQuery = channel('datadog:apollo-core:runhttpquery:start')
const successRunHttpQuery = channel('datadog:apollo-core:runhttpquery:success')

addHook({ name: 'apollo-server-core', file: 'dist/runHttpQuery.js', versions: ['>3.0.0'] }, runHttpQueryModule => {
  shimmer.wrap(runHttpQueryModule, 'runHttpQuery', function wrapRunHttpQuery (originalRunHttpQuery) {
    return async function runHttpQuery () {
      if (!startRunHttpQuery.hasSubscribers) {
        return originalRunHttpQuery.apply(this, arguments)
      }
      const asyncResource = new AsyncResource('bound-anonymous-fn')
      return asyncResource.runInAsyncScope(async () => {
        const abortController = new AbortController()
        startRunHttpQuery.publish()
        const abortData = {}
        const httpRunPromise = await originalRunHttpQuery.apply(this, arguments)
        return asyncResource.runInAsyncScope(() => {
          successRunHttpQuery.publish({ abortController, abortData })
          if (abortController.signal.aborted) {
            return new Promise((resolve, reject) => {
              const error = new Error()
              error.name = 'HttpQueryError'
              error.headers = abortData.headers
              error.statusCode = abortData.statusCode
              error.message = abortData.message

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
