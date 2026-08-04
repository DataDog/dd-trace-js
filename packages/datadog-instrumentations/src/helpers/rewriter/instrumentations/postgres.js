'use strict'

const builds = ['src/connection.js', 'cjs/src/connection.js'].map(filePath => ({
  module: {
    name: 'postgres',
    versionRange: '>=3.0.0 <4',
    filePath,
  },
  astQuery: 'Program',
  transform: 'postgresQueryBuild',
  channelName: 'query',
}))

const handlers = ['src/index.js', 'cjs/src/index.js'].map(filePath => ({
  module: {
    name: 'postgres',
    versionRange: '>=3.0.0 <4',
    filePath,
  },
  astQuery: 'Program',
  transform: 'postgresQueryHandlers',
  channelName: 'query',
}))

const lifecycles = ['src/query.js', 'cjs/src/query.js'].map(filePath => ({
  module: {
    name: 'postgres',
    versionRange: '>=3.0.0 <4',
    filePath,
  },
  astQuery: 'Program',
  transform: 'postgresQueryLifecycle',
  channelName: 'query',
}))

module.exports = [...builds, ...handlers, ...lifecycles]
