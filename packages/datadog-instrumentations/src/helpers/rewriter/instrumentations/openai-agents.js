'use strict'

module.exports = [
  {
    module: {
      name: '@openai/agents-core',
      versionRange: '>=0.8.2',
      filePath: 'dist/run.js',
    },
    functionQuery: {
      methodName: 'run',
      className: 'Runner',
      kind: 'Async',
    },
    channelName: 'run',
  },
]
