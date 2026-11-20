'use strict'

module.exports = [
  {
    module: {
      name: 'bull',
      versionRange: '>=3.11.0',
      filePath: 'lib/job.js',
    },
    functionQuery: {
      objectName: 'Job',
      propertyName: 'create',
      kind: 'Async',
    },
    channelName: 'Job_create',
  },
  {
    module: {
      name: 'bull',
      versionRange: '>=3.11.0',
      filePath: 'lib/job.js',
    },
    functionQuery: {
      objectName: 'Job',
      propertyName: 'createBulk',
      kind: 'Async',
    },
    channelName: 'Job_createBulk',
  },
  {
    module: {
      name: 'bull',
      versionRange: '>=3.11.0',
      filePath: 'lib/job.js',
    },
    functionQuery: {
      expressionName: 'moveToFailed',
      kind: 'Async',
    },
    channelName: 'Job_moveToFailed',
  },
  {
    module: {
      name: 'bull',
      versionRange: '>=3.11.0',
      filePath: 'lib/queue.js',
    },
    functionQuery: {
      expressionName: 'processJob',
      kind: 'Async',
    },
    channelName: 'Queue_processJob',
  },
]
