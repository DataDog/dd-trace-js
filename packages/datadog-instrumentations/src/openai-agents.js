'use strict'

const dc = require('dc-polyfill')
const shimmer = require('../../datadog-shimmer')
const { addHook } = require('./helpers/instrument')

const getResponseCh = dc.tracingChannel('apm:openai-agents:getResponse')
const getStreamedResponseCh = dc.tracingChannel('apm:openai-agents:getStreamedResponse')

// Register @openai/agents so withVersions can find it for testing
addHook({ name: '@openai/agents', versions: ['>=0.4.3'] }, exports => exports)

function wrapOpenAIChatCompletionsModel (exports) {
  const OpenAIChatCompletionsModel = exports.OpenAIChatCompletionsModel

  if (!OpenAIChatCompletionsModel || !OpenAIChatCompletionsModel.prototype) {
    return exports
  }

  // Wrap getResponse method
  shimmer.wrap(OpenAIChatCompletionsModel.prototype, 'getResponse', getResponse => {
    return function wrappedGetResponse (request) {
      if (!getResponseCh.start.hasSubscribers) {
        return getResponse.apply(this, arguments)
      }

      const ctx = {
        request,
        methodName: 'getResponse'
      }

      return getResponseCh.start.runStores(ctx, () => {
        const promise = getResponse.apply(this, arguments)

        return promise.then(
          result => {
            ctx.result = result
            getResponseCh.asyncEnd.publish(ctx)
            return result
          },
          error => {
            ctx.error = error
            getResponseCh.error.publish(ctx)
            throw error
          }
        )
      })
    }
  })

  // Wrap getStreamedResponse method
  shimmer.wrap(OpenAIChatCompletionsModel.prototype, 'getStreamedResponse', getStreamedResponse => {
    return function wrappedGetStreamedResponse (request) {
      if (!getStreamedResponseCh.start.hasSubscribers) {
        return getStreamedResponse.apply(this, arguments)
      }

      const ctx = {
        request,
        methodName: 'getStreamedResponse'
      }

      return getStreamedResponseCh.start.runStores(ctx, () => {
        const result = getStreamedResponse.apply(this, arguments)

        // getStreamedResponse returns a stream object, not a promise
        // Finish the span immediately since we can't track stream completion
        if (!result || typeof result.then !== 'function') {
          ctx.result = result
          getStreamedResponseCh.asyncEnd.publish(ctx)
          return result
        }

        // Handle promise case (for future compatibility)
        return result.then(
          promiseResult => {
            ctx.result = promiseResult
            getStreamedResponseCh.asyncEnd.publish(ctx)
            return promiseResult
          },
          error => {
            ctx.error = error
            getStreamedResponseCh.error.publish(ctx)
            throw error
          }
        )
      })
    }
  })

  return exports
}

// Hook the main package export (dist/index.js) which exports OpenAIChatCompletionsModel
addHook({
  name: '@openai/agents-openai',
  versions: ['>=0.4.3']
}, wrapOpenAIChatCompletionsModel)
