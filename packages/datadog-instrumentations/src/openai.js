'use strict'

const {
  channel,
  addHook
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const startCh = channel('apm:openai:request:start')
const finishCh = channel('apm:openai:request:finish')
const errorCh = channel('apm:openai:request:error')

addHook({ name: 'openai', file: 'dist/api.js', versions: ['>=3.0.0'] }, exports => {
  const methodNames = Object.getOwnPropertyNames(exports.OpenAIApi.prototype)
  methodNames.shift() // remove leading 'constructor' method

  for (const methodName of methodNames) {
    shimmer.wrap(exports.OpenAIApi.prototype, methodName, fn => async function () {
      if (!startCh.hasSubscribers) {
        return fn.apply(this, arguments)
      }

      startCh.publish({
        methodName,
        args: arguments,
        basePath: this.basePath,
        apiKey: this.configuration.apiKey
      })

      try {
        const response = await fn.apply(this, arguments)

        finishCh.publish({
          headers: response.headers,
          body: response.data,
          path: response.request.path,
          method: response.request.method
        })

        return response
      } catch (err) {
        errorCh.publish({ err })

        throw err
      }
    })
  }

  return exports
})
