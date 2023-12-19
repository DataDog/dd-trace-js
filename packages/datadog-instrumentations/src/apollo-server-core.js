'use strict'

const { AbortController } = require('node-abort-controller')
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

      return Promise.race([runHttpQueryResult]).then((value) => {
        if (abortController.signal.aborted) {
          // runHttpQuery callbacks are writing the response on resolve/reject.
          // We should return blocking data in the apollo-server-core HttpQueryError object
          return Promise.reject(new HttpQueryError(abortData.statusCode, abortData.message, true, abortData.headers))
        }
        return value
      })
    }
  })

  return runHttpQueryModule
})
