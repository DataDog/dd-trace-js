'use strict'

module.exports = [
  {
    module: {
      name: 'bullmq',
      versionRange: '>=5.66.2',
      filePath: 'dist/cjs/classes/queue.js'
    },
    functionQuery: {
      methodName: 'add',
      className: 'Queue',
      kind: 'Async'
    },
    channelName: 'Queue_add'
  },
  {
    module: {
      name: 'bullmq',
      versionRange: '>=5.66.2',
      filePath: 'dist/cjs/classes/queue.js'
    },
    functionQuery: {
      methodName: 'addBulk',
      className: 'Queue',
      kind: 'Async'
    },
    channelName: 'Queue_addBulk'
  },
  {
    module: {
      name: 'bullmq',
      versionRange: '>=5.66.2',
      filePath: 'dist/cjs/classes/worker.js'
    },
    functionQuery: {
      methodName: 'processJob',
      className: 'Worker',
      kind: 'Async'
    },
    channelName: 'Worker_processJob'
  },
  {
    module: {
      name: 'bullmq',
      versionRange: '>=5.66.2',
      filePath: 'dist/cjs/classes/flow-producer.js'
    },
    functionQuery: {
      methodName: 'add',
      className: 'FlowProducer',
      kind: 'Async'
    },
    channelName: 'FlowProducer_add'
  }
]
