'use strict'

const instrumentations = []

for (const filePath of ['dist/development/index.js', 'dist/production/index.js']) {
  for (const functionName of ['derive', 'matchServerRoutes']) {
    instrumentations.push({
      module: { name: 'react-router', versionRange: '>=7.9.5 <8', filePath },
      functionQuery: { functionName },
      channelName: functionName,
    })
  }
}

const chunkFilePath = /^dist\/(?:development|production)\/chunk-[A-Z0-9]+\.mjs$/
for (const functionName of ['derive', 'matchServerRoutes']) {
  instrumentations.push({
    module: {
      name: 'react-router',
      versionRange: '>=7.9.5 <8',
      filePath: chunkFilePath,
      sourceMatch: 'function derive(',
    },
    functionQuery: { functionName },
    channelName: functionName,
  })
}

for (const mode of ['development', 'production']) {
  instrumentations.push({
    module: {
      name: 'react-router',
      versionRange: '>=8',
      filePath: `dist/${mode}/lib/server-runtime/server.js`,
    },
    functionQuery: { functionName: 'derive' },
    channelName: 'derive',
  }, {
    module: {
      name: 'react-router',
      versionRange: '>=8',
      filePath: `dist/${mode}/lib/server-runtime/routeMatching.js`,
    },
    functionQuery: { functionName: 'matchServerRoutes' },
    channelName: 'matchServerRoutes',
  })
}

module.exports = instrumentations
