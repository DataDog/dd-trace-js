'use strict'

const handlers = ['src/index.js', 'cjs/src/index.js'].map(filePath => ({
  module: {
    name: 'postgres',
    versionRange: '>=3.0.0',
    filePath,
  },
  astQuery: 'Program',
  transform: 'postgresQueryHandlers',
  channelName: 'query',
}))

const acquisitions = ['src/connection.js', 'cjs/src/connection.js'].map(filePath => ({
  module: {
    name: 'postgres',
    versionRange: '>=3.0.0',
    filePath,
  },
  astQuery: 'Program',
  transform: 'postgresQueryAcquire',
  channelName: 'query:acquire',
}))

const preparations = ['src/connection.js', 'cjs/src/connection.js'].map(filePath => ({
  module: {
    name: 'postgres',
    versionRange: '>=3.0.0',
    filePath,
  },
  astQuery: 'Program',
  transform: 'postgresQueryPreparation',
  channelName: 'query:prepare',
}))

const lifecycles = ['src/query.js', 'cjs/src/query.js'].map(filePath => ({
  module: {
    name: 'postgres',
    versionRange: '>=3.0.0',
    filePath,
  },
  astQuery: 'Program',
  transform: 'postgresQueryLifecycle',
  channelName: 'query',
}))

module.exports = [...handlers, ...acquisitions, ...preparations, ...lifecycles]
