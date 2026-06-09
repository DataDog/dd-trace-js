'use strict'

module.exports = [
  {
    module: {
      name: 'nats',
      versionRange: '>=2.29.3',
      filePath: 'lib/nats-base-client/nats.js',
    },
    functionQuery: {
      methodName: 'publish',
      kind: 'Async',
    },
    channelName: 'publish',
  },
  {
    module: {
      name: 'nats',
      versionRange: '>=2.29.3',
      filePath: 'lib/nats-base-client/protocol.js',
    },
    functionQuery: {
      methodName: 'processMsg',
      kind: 'Sync',
    },
    channelName: 'processMsg',
  },
  {
    module: {
      name: 'nats',
      versionRange: '>=2.29.3',
      filePath: 'lib/nats-base-client/nats.js',
    },
    functionQuery: {
      methodName: 'request',
      kind: 'Async',
    },
    channelName: 'request',
  },
]
