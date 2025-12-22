'use strict'

module.exports = [
  {
    module: {
      name: 'postgres',
      versionRange: '>=3.4.7',
      filePath: 'cjs/src/query.js'
    },
    functionQuery: {
      methodName: 'handle',
      className: 'Query',
      kind: 'Async'
    },
    channelName: 'Query_handle'
  }
]
