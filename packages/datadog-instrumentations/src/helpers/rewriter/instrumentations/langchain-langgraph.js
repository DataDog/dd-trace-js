'use strict'

module.exports = [
  {
    module: {
      name: '@langchain/langgraph',
      versionRange: '>=1.2.0',
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
      versionRange: '>=1.2.0',
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
