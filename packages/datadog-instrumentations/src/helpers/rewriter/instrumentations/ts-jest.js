'use strict'

module.exports = [
  {
    module: {
      name: 'ts-jest',
      versionRange: '29.4.5',
      filePath: 'dist/legacy/ts-jest-transformer.js',
    },
    functionQuery: {
      className: 'TsJestTransformer',
      methodName: 'getCacheKey',
      kind: 'Sync',
    },
    channelName: 'getCacheKey',
  },
  {
    module: {
      name: 'ts-jest',
      versionRange: '29.4.5',
      filePath: 'dist/utils/sha1.js',
    },
    functionQuery: {
      functionName: 'sha1',
      kind: 'Sync',
    },
    channelName: 'cacheHash',
  },
]
