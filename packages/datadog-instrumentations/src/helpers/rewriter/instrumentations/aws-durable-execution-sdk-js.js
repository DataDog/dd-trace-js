'use strict'

const contextMethods = require('../../../aws-durable-execution-sdk-js-context-methods')

const baseModule = { name: '@aws/durable-execution-sdk-js', versionRange: '>=1.1.0' }

const buildEntries = filePath => {
  const module = { ...baseModule, filePath }
  return [
    {
      module,
      functionQuery: { functionName: 'runHandler', kind: 'Async' },
      channelName: 'withDurableExecution',
    },
    ...contextMethods.map(methodName => ({
      module,
      functionQuery: { className: 'DurableContextImpl', methodName, kind: 'Sync' },
      channelName: `DurableContextImpl_${methodName}`,
    })),
    {
      module,
      functionQuery: { className: 'CheckpointManager', methodName: 'checkpoint', kind: 'Async' },
      channelName: 'CheckpointManager_checkpoint',
    },
  ]
}

module.exports = [
  ...buildEntries('dist/index.mjs'),
  ...buildEntries('dist-cjs/index.js'),
]
