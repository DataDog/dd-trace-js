'use strict'

module.exports = [
  {
    module: {
      name: 'async-mutex',
      versionRange: '>=0.5.0',
      filePath: 'lib/Semaphore.js',
    },
    functionQuery: {
      expressionName: 'acquire',
      kind: 'Async',
    },
    channelName: 'Semaphore_acquire',
  },
  {
    module: {
      name: 'async-mutex',
      versionRange: '>=0.5.0',
      filePath: 'es6/Semaphore.js',
    },
    functionQuery: {
      expressionName: 'acquire',
      kind: 'Async',
    },
    channelName: 'Semaphore_acquire',
  },
  {
    module: {
      name: 'async-mutex',
      versionRange: '>=0.5.0',
      filePath: 'index.mjs',
    },
    functionQuery: {
      className: 'Semaphore',
      methodName: 'acquire',
      kind: 'Async',
    },
    channelName: 'Semaphore_acquire',
  },
]
