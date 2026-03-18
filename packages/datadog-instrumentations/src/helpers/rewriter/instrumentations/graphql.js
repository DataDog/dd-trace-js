'use strict'

module.exports = [
  {
    module: {
      name: 'graphql',
      versionRange: '>=0.10.0',
      filePath: 'language/parser.js',
    },
    functionQuery: {
      functionName: 'parse',
      kind: 'Sync',
    },
    channelName: 'graphql_parse',
  },
  {
    module: {
      name: 'graphql',
      versionRange: '>=0.10.0',
      filePath: 'language/parser.mjs',
    },
    functionQuery: {
      functionName: 'parse',
      kind: 'Sync',
    },
    channelName: 'graphql_parse',
  },
  {
    module: {
      name: 'graphql',
      versionRange: '>=0.10.0',
      filePath: 'validation/validate.js',
    },
    functionQuery: {
      functionName: 'validate',
      kind: 'Sync',
    },
    channelName: 'graphql_validate',
  },
  {
    module: {
      name: 'graphql',
      versionRange: '>=0.10.0',
      filePath: 'validation/validate.mjs',
    },
    functionQuery: {
      functionName: 'validate',
      kind: 'Sync',
    },
    channelName: 'graphql_validate',
  },
  {
    module: {
      name: 'graphql',
      versionRange: '>=0.10.0',
      filePath: 'execution/execute.js',
    },
    functionQuery: {
      functionName: 'execute',
      kind: 'Async',
    },
    channelName: 'graphql_execute',
  },
  {
    module: {
      name: 'graphql',
      versionRange: '>=0.10.0',
      filePath: 'execution/execute.mjs',
    },
    functionQuery: {
      functionName: 'execute',
      kind: 'Async',
    },
    channelName: 'graphql_execute',
  },
]
