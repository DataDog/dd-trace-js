'use strict'

module.exports = [
  {
    module: {
      name: '@langchain/langgraph',
      versionRange: '>=1.1.2',
      filePath: 'dist/pregel/index.js',
    },
    functionQuery: {
      methodName: 'invoke',
      className: 'Pregel',
      kind: 'Async',
    },
    channelName: 'Pregel_invoke',
  },
  {
    module: {
      name: '@langchain/langgraph',
      versionRange: '>=1.1.2',
      filePath: 'dist/pregel/index.cjs',
    },
    functionQuery: {
      methodName: 'invoke',
      className: 'Pregel',
      kind: 'Async',
    },
    channelName: 'Pregel_invoke',
  },
  {
    module: {
      name: '@langchain/langgraph',
      versionRange: '>=1.1.2',
      filePath: 'dist/pregel/index.js',
    },
    functionQuery: {
      methodName: 'stream',
      className: 'Pregel',
      kind: 'AsyncIterator',
    },
    channelName: 'Pregel_stream',
  },
  {
    module: {
      name: '@langchain/langgraph',
      versionRange: '>=1.1.2',
      filePath: 'dist/pregel/index.cjs',
    },
    functionQuery: {
      methodName: 'stream',
      className: 'Pregel',
      kind: 'AsyncIterator',
    },
    channelName: 'Pregel_stream',
  },
]
