'use strict'

module.exports = [
  {
    module: {
      name: 'bee-queue',
      versionRange: '>=2.0.0',
      filePath: 'lib/job.js'
    },
    functionQuery: {
      methodName: 'save',
      className: 'Job',
      kind: 'Async'
    },
    channelName: 'Job_save'
  },
  {
    module: {
      name: 'bee-queue',
      versionRange: '>=2.0.0',
      filePath: 'lib/queue.js'
    },
    functionQuery: {
      methodName: '_runJob',
      className: 'Queue',
      kind: 'Async'
    },
    channelName: 'Queue__runJob'
  },
  {
    module: {
      name: 'bee-queue',
      versionRange: '>=2.0.0',
      filePath: 'lib/queue.js'
    },
    functionQuery: {
      methodName: 'saveAll',
      className: 'Queue',
      kind: 'Async'
    },
    channelName: 'Queue_saveAll'
  }
]
