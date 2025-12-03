'use strict'

const { addHook } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')
const tracingChannel = require('dc-polyfill').tracingChannel
const channel = require('dc-polyfill').channel

const genaiTracingChannel = tracingChannel('apm:google:genai:request')
const onStreamedChunkCh = channel('apm:google:genai:request:chunk')

function wrapGenerateContent (method) {
  return function wrappedGenerateContent (original) {
    return function (...args) {
      if (!genaiTracingChannel.start.hasSubscribers) {
        return original.apply(this, args)
      }

      const normalizedName = normalizeMethodName(method)

      const ctx = { args, methodName: normalizedName }

      return genaiTracingChannel.start.runStores(ctx, () => {
        let result
        try {
          result = original.apply(this, arguments)
        } catch (error) {
          finish(ctx, null, error)
          throw error
        } finally {
          genaiTracingChannel.end.publish(ctx)
        }
        return result.then(response => {
          if (response[Symbol.asyncIterator]) {
            shimmer.wrap(response, Symbol.asyncIterator, iterator => wrapStreamIterator(iterator, ctx))
          } else {
            finish(ctx, response, null)
          }
          return response
        }).catch(error => {
          finish(ctx, null, error)
          throw error
        })
      })
    }
  }
}

function wrapStreamIterator (iterator, ctx) {
  return function () {
    const itr = iterator.apply(this, arguments)
    shimmer.wrap(itr, 'next', next => function () {
      return next.apply(this, arguments)
        .then(res => {
          const { done, value: chunk } = res
          onStreamedChunkCh.publish({ ctx, chunk, done })

          if (done) {
            finish(ctx)
          }

          return res
        })
        .catch(error => {
          finish(ctx, null, error)
          throw error
        })
    })

    return itr
  }
}
function finish (ctx, result, error) {
  if (error) {
    ctx.error = error
    genaiTracingChannel.error.publish(ctx)
  }

  // streamed responses are handled and set separately
  ctx.result ??= result

  genaiTracingChannel.asyncEnd.publish(ctx)
}
// Hook the main package entry point
addHook({
  name: '@google/genai',
  versions: ['>=1.19.0']
}, exports => {
  // Wrap GoogleGenAI to intercept when it creates Models instances
  if (!exports.GoogleGenAI) return exports

  shimmer.wrap(exports, 'GoogleGenAI', GoogleGenAI => {
    return class extends GoogleGenAI {
      constructor (...args) {
        super(...args)

        // We are patching the instance instead of the prototype because when it is compiled from
        // typescript, the models property is not available on the prototype.
        if (this.models) {
          if (this.models.generateContent) {
            shimmer.wrap(this.models, 'generateContent', wrapGenerateContent('generateContent'))
          }
          if (this.models.generateContentStream) {
            shimmer.wrap(this.models, 'generateContentStream', wrapGenerateContent('generateContentStream'))
          }
          if (this.models.embedContent) {
            shimmer.wrap(this.models, 'embedContent', wrapGenerateContent('embedContent'))
          }
        }
      }
    }
  })
  return exports
})

function normalizeMethodName (methodName) {
  // Convert camelCase to snake_case and add Models prefix
  return 'Models.' + methodName
    .replaceAll(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
}
