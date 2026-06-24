'use strict'

module.exports = [
  {
    module: {
      name: '@openai/agents-openai',
      versionRange: '>=0.7.0',
      filePath: 'dist/openaiResponsesModel.js',
    },
    functionQuery: {
      methodName: 'getStreamedResponse',
      className: 'OpenAIResponsesModel',
    },
    channelName: 'OAI_getStreamedResponse',
    transform: 'traceAsyncIterator',
  },
  {
    module: {
      name: '@openai/agents-openai',
      versionRange: '>=0.7.0',
      filePath: 'dist/openaiResponsesModel.mjs',
    },
    functionQuery: {
      methodName: 'getStreamedResponse',
      className: 'OpenAIResponsesModel',
    },
    channelName: 'OAI_getStreamedResponse',
    transform: 'traceAsyncIterator',
  },
]
