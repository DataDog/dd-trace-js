'use strict'

module.exports = [
  {
    module: {
      name: '@langchain/langgraph',
      versionRange: '>=1.0.15',
      filePath: 'dist/pregel/index.js'
    },
    functionQuery: {
      methodName: 'invoke',
      className: 'Pregel',
      kind: 'Async'
    },
    channelName: 'Pregel_invoke'
  },
  {
    module: {
      name: '@langchain/langgraph',
      versionRange: '>=1.0.15',
      filePath: 'dist/pregel/index.cjs'
    },
    functionQuery: {
      methodName: 'invoke',
      className: 'Pregel',
      kind: 'Async'
    },
    channelName: 'Pregel_invoke'
  },
  {
    module: {
      name: '@langchain/langgraph',
      versionRange: '>=1.0.15',
      filePath: 'dist/pregel/index.js'
    },
    functionQuery: {
      methodName: '_streamIterator',
      className: 'Pregel',
      kind: 'Async'
    },
    channelName: 'Pregel__streamIterator'
  },
  {
    module: {
      name: '@langchain/langgraph',
      versionRange: '>=1.0.15',
      filePath: 'dist/pregel/index.cjs'
    },
    functionQuery: {
      methodName: '_streamIterator',
      className: 'Pregel',
      kind: 'Async'
    },
    channelName: 'Pregel__streamIterator'
  },
  {
    module: {
      name: '@langchain/langgraph',
      versionRange: '>=1.0.15',
      filePath: 'dist/pregel/retry.js'
    },
    functionQuery: {
      methodName: '_runWithRetry',
      kind: 'Async'
    },
    channelName: '_runWithRetry'
  },
  {
    module: {
      name: '@langchain/langgraph',
      versionRange: '>=1.0.15',
      filePath: 'dist/pregel/retry.cjs'
    },
    functionQuery: {
      methodName: '_runWithRetry',
      kind: 'Async'
    },
    channelName: '_runWithRetry'
  }
]
