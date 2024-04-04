'use strict'

const {
  channel,
  addHook
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const startCh = channel('apm:openai:request:start')
const finishCh = channel('apm:openai:request:finish')
const errorCh = channel('apm:openai:request:error')

const completionFinishCh = channel('datadog:openai:completion:finish')

addHook({ name: 'openai', file: 'dist/api.js', versions: ['>=3.0.0 <4'] }, exports => {
  const methodNames = Object.getOwnPropertyNames(exports.OpenAIApi.prototype)
  methodNames.shift() // remove leading 'constructor' method

  for (const methodName of methodNames) {
    shimmer.wrap(exports.OpenAIApi.prototype, methodName, fn => function () {
      if (!startCh.hasSubscribers) {
        return fn.apply(this, arguments)
      }

      startCh.publish({
        methodName,
        args: arguments,
        basePath: this.basePath,
        apiKey: this.configuration.apiKey
      })

      return fn.apply(this, arguments)
        .then((response) => {
          finishCh.publish({
            headers: response.headers,
            body: response.data,
            path: response.request.path,
            method: response.request.method
          })

          return response
        })
        .catch((err) => {
          errorCh.publish({ err })

          throw err
        })
    })
  }

  return exports
})

addHook({ name: 'openai', file: 'resources/chat/completions.js', versions: ['>=4'] }, exports => {
  shimmer.wrap(exports.Completions.prototype, 'create', fn => function (body) {
    // arguments[0].messages[0].content
    const result = fn.apply(this, arguments)
    if (completionFinishCh.hasSubscribers) {
      if (!body?.stream) {
        shimmer.wrap(result, 'then', fn => function () {
          const originalThen = arguments[0]
          arguments[0] = shimmer.wrap(arguments[0], function (output) {
            completionFinishCh.publish({
              input: body,
              output
            })

            return originalThen.apply(this, arguments)
          })
          return fn.apply(this, arguments)
        })
      }
    }

    return result
  })
  return exports
})
