'use strict'

const { addHook } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const vertexaiTracingChannel = require('dc-polyfill').tracingChannel('apm:vertexai:request')

// TODO: this might need to be take in a `isChat` argument for history or something
function wrapGenerateContent (generateContent) {
  return function (request) {
    if (!vertexaiTracingChannel.start.hasSubscribers) {
      return generateContent.apply(this, arguments)
    }

    const ctx = {
      request,
      func: 'generateContent'
    }

    return vertexaiTracingChannel.tracePromise(generateContent, ctx, this, ...arguments)
  }
}

addHook({
  name: '@google-cloud/vertexai',
  file: 'build/src/models/generative_models.js',
  versions: ['>=1.9.3']
}, exports => {
  const GenerativeModel = exports.GenerativeModel

  shimmer.wrap(GenerativeModel.prototype, 'generateContent', wrapGenerateContent)
  // TODO: wrap `generateContentStream`

  return exports
})

addHook({
  name: '@google-cloud/vertexai',
  file: 'build/src/models/chat_session.js',
  versions: ['>=1.9.3']
}, exports => {
  // TODO: wrap `sendMessage` and `sendMessageStream`

  return exports
})
