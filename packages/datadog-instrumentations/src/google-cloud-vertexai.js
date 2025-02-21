'use strict'

const { addHook } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const vertexaiTracingChannel = require('dc-polyfill').tracingChannel('apm:vertexai:request')

function wrapGenerate (generate) {
  return function (request) {
    if (!vertexaiTracingChannel.start.hasSubscribers) {
      return generate.apply(this, arguments)
    }

    const ctx = {
      request,
      instance: this,
      resource: [this.constructor.name, generate.name].join('.')
    }

    return vertexaiTracingChannel.tracePromise(generate, ctx, this, ...arguments)
  }
}

function wrapGenerateStream (generateStream) {
  return function (request) {
    if (!vertexaiTracingChannel.start.hasSubscribers) {
      return generateStream.apply(this, arguments)
    }

    const ctx = {
      request,
      instance: this,
      resource: [this.constructor.name, generateStream.name].join('.'),
      stream: true
    }

    return vertexaiTracingChannel.start.runStores(ctx, () => {
      let streamingResult
      try {
        streamingResult = generateStream.apply(this, arguments)
      } catch (e) {
        ctx.error = e
        vertexaiTracingChannel.error.publish(e)
        vertexaiTracingChannel.end.publish(ctx)
        vertexaiTracingChannel.asyncEnd.publish(ctx)
        throw e
      }

      vertexaiTracingChannel.end.publish(ctx)

      return streamingResult.then(stream => {
        stream.response.then(response => {
          ctx.result = { response }
          vertexaiTracingChannel.asyncEnd.publish(ctx)
        })
        return stream
      }).catch(e => {
        ctx.error = e
        vertexaiTracingChannel.error.publish(e)
        vertexaiTracingChannel.asyncEnd.publish(ctx)
        throw e
      })
    })
  }
}

addHook({
  name: '@google-cloud/vertexai',
  file: 'build/src/models/generative_models.js',
  versions: ['>=1.0.0']
}, exports => {
  const GenerativeModel = exports.GenerativeModel

  shimmer.wrap(GenerativeModel.prototype, 'generateContent', wrapGenerate)
  shimmer.wrap(GenerativeModel.prototype, 'generateContentStream', wrapGenerateStream)

  return exports
})

addHook({
  name: '@google-cloud/vertexai',
  file: 'build/src/models/chat_session.js',
  versions: ['>=1.0.0']
}, exports => {
  const ChatSession = exports.ChatSession

  shimmer.wrap(ChatSession.prototype, 'sendMessage', wrapGenerate)
  shimmer.wrap(ChatSession.prototype, 'sendMessageStream', wrapGenerateStream)

  return exports
})
