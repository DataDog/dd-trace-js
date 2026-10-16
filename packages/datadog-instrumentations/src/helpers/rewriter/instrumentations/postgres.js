'use strict'

const instrumentations = []

for (const filePath of ['src/index.js', 'cjs/src/index.js']) {
  instrumentations.push({
    module: {
      name: 'postgres',
      versionRange: '>=3.0.0',
      filePath,
    },
    astQuery: 'Program',
    transform: 'postgresQueryHandlers',
    channelName: 'query',
  })
}

for (const filePath of ['src/connection.js', 'cjs/src/connection.js']) {
  instrumentations.push({
    module: {
      name: 'postgres',
      versionRange: '>=3.0.0',
      filePath,
    },
    astQuery: 'Program',
    transform: 'postgresQueryAcquire',
    channelName: 'query:acquire',
  })
}

for (const filePath of ['src/connection.js', 'cjs/src/connection.js']) {
  instrumentations.push({
    module: {
      name: 'postgres',
      versionRange: '>=3.0.0',
      filePath,
    },
    astQuery: 'Program',
    transform: 'postgresQueryPreparation',
    channelName: 'query:prepare',
  })
}

for (const filePath of ['src/query.js', 'cjs/src/query.js']) {
  instrumentations.push({
    module: {
      name: 'postgres',
      versionRange: '>=3.0.0',
      filePath,
    },
    astQuery: 'Program',
    transform: 'postgresQueryLifecycle',
    channelName: 'query',
  })
}

module.exports = instrumentations
