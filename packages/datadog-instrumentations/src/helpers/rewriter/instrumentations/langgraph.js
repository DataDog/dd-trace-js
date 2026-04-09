'use strict'

module.exports = [
  {
    module: {
      name: '@langchain/langgraph',
      versionRange: '>=1.1.2',
      filePath: 'dist/pregel/index.js',
    },
    functionQuery: {
      methodName: 'stream',
      className: 'Pregel',
    },
    channelName: 'Pregel_stream',
    transform: 'traceAsyncIterator',
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
    },
    channelName: 'Pregel_stream',
    transform: 'traceAsyncIterator',
  },
]
