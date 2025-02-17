'use strict'

const { addHook } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')
const dc = require('dc-polyfill')

const requestChannel = dc.tracingChannel('datadog:apollo-server-core:request')

addHook({ name: 'apollo-server-core', file: 'dist/runHttpQuery.js', versions: ['>3.0.0'] }, runHttpQueryModule => {
  const HttpQueryError = runHttpQueryModule.HttpQueryError

  shimmer.wrap(runHttpQueryModule, 'runHttpQuery', function wrapRunHttpQuery (originalRunHttpQuery) {
    return async function runHttpQuery () {
      if (!requestChannel.start.hasSubscribers) {
        return originalRunHttpQuery.apply(this, arguments)
      }

      const abortController = new AbortController()
      const abortData = {}

      const runHttpQueryResult = requestChannel.tracePromise(
        originalRunHttpQuery,
        { abortController, abortData },
        this,
        ...arguments)

      const abortPromise = new Promise((resolve, reject) => {
        abortController.signal.addEventListener('abort', (event) => {
          // runHttpQuery callbacks are writing the response on resolve/reject.
          // We should return blocking data in the apollo-server-core HttpQueryError object
          reject(new HttpQueryError(abortData.statusCode, abortData.message, true, abortData.headers))
        }, { once: true })
      })

      return Promise.race([runHttpQueryResult, abortPromise])
    }
  })

  return runHttpQueryModule
})
