'use strict'

module.exports = [
  {
    module: {
      name: 'durable-functions',
      versionRange: '>=3 <4',
      filePath: 'lib/src/orchestrations/TaskOrchestrationExecutor.js',
    },
    functionQuery: {
      className: 'TaskOrchestrationExecutor',
      methodName: 'execute',
    },
    transform: 'publishDurableOrchestrationFailure',
    channelName: 'TaskOrchestrationExecutor_failure',
  },
]
