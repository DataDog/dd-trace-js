'use strict'

module.exports = [
  {
    module: {
      name: '@electric-sql/pglite',
      versionRange: '>=0.3.14',
      filePath: 'dist/index.cjs'
    },
    functionQuery: {
      methodName: 'query',
      className: 'BasePGlite',
      kind: 'Async'
    },
    channelName: 'BasePGlite_query'
  },
  {
    module: {
      name: '@electric-sql/pglite',
      versionRange: '>=0.3.14',
      filePath: 'dist/index.cjs'
    },
    functionQuery: {
      methodName: 'exec',
      className: 'BasePGlite',
      kind: 'Async'
    },
    channelName: 'BasePGlite_exec'
  },
  {
    module: {
      name: '@electric-sql/pglite',
      versionRange: '>=0.3.14',
      filePath: 'dist/index.cjs'
    },
    functionQuery: {
      methodName: 'transaction',
      className: 'BasePGlite',
      kind: 'Async'
    },
    channelName: 'BasePGlite_transaction'
  }
]
